import { randomUUID as cryptoRandomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';

import {
  LEDGER_LIMITS,
  LedgerCommandReceiptSchema,
  LedgerEntrySchema,
  LedgerMutationSchema,
  LedgerSequenceSchema,
  LedgerTitleSchema,
  LedgerUuidSchema,
  LedgerWorkSummaryGetResultSchema,
  isLedgerGlobalContainer,
  ledgerGlobalOwnerKey,
  toLedgerEntrySearchItem,
  type LedgerActorRef,
  type LedgerAttribution,
  type LedgerChangesListResult,
  type LedgerCommandReceipt,
  type LedgerContainer,
  type LedgerEntry,
  type LedgerEntryGetResult,
  type LedgerLeftOpen,
  type LedgerMutation,
  type LedgerRollupsListResult,
  type LedgerSourceAvailability,
  type LedgerStatus,
  type LedgerSyncState,
  type LedgerWorkSummaryGetResult,
} from '@canopy/protocol/canopy-core';

import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  isLedgerCursorFresh,
  type LedgerCursorState,
} from './cursor';
import {
  LEDGER_DEFAULT_OPEN_BUSY_TIMEOUT_MS,
  closeQuietly,
  openExclusiveLedgerDatabase,
  rollbackQuietly,
} from './database';
import { LedgerStoreError, toLedgerStoreError } from './errors';
import {
  hashLedgerCanonicalValue,
  sha256Hex,
  toCanonicalJson,
  type LedgerCanonicalValue,
} from './hashing';
import {
  canPurgeLedgerScope,
  canRebindLedgerScope,
  hasLedgerContainerLifecycle,
  isLedgerScopeWritable,
  ledgerScopeLifecycleRejection,
  ledgerScopeLifecycleStep,
} from './lifecycle';
import {
  canLedgerActorOwn,
  canLedgerActorUpdateOwnedEntry,
  checkLedgerAttribution,
  checkLedgerCreation,
  evaluateLedgerUpdate,
  isLedgerEntryOpen,
  sameLedgerActor,
  type LedgerPolicyViolation,
  type LedgerStatusChange,
  type LedgerOwnerChange,
  type LedgerUpdateRejection,
} from './policy';
import {
  actorFromRow,
  parseLedgerInput,
  parseStoredEntry,
  parseStoredRecord,
  scopeFromRow,
  type LedgerScopeState,
} from './records';
import {
  assertSameLedgerActorRegistration,
  ledgerGlobalAccountKey,
  parseLedgerActorRegistration,
  parseLedgerContainerColumns,
  parseLedgerGlobalScopeBinding,
  parseLedgerGlobalScopeKey,
  parseLedgerIdInput,
  parseLedgerScopeBinding,
  parseLedgerScopeLifecycleChange,
  parseLedgerScopeRebinding,
  parseLedgerScopeIdentity,
  type LedgerActorRegistration,
  type LedgerGlobalScopeKey,
  type LedgerScopeBinding,
  type LedgerScopeIdentity,
} from './registrations';
import {
  normalizeAddEntryRequest,
  normalizeHandBackEntryRequest,
  normalizeLedgerWorkSummaryInput,
  normalizeReceiptKeysRequest,
  normalizeSummaryRequest,
  normalizeUpdateEntryRequest,
  type LedgerCreateRequest,
  type LedgerEntryDraft,
  type LedgerHandBackRequest,
  type LedgerReceiptKey,
  type LedgerUpdateRequest,
} from './requests';
import { listLedgerRollups, type LedgerRollupsInput } from './rollups';
import {
  rowInteger,
  rowLeftOpen,
  rowNullableText,
  rowText,
  parseStoredJson,
  type LedgerSqlRow,
} from './rows';
import {
  createEphemeralLedgerCursorSecret,
  migrateLedgerSchema,
  readLedgerAuthorityId,
  readLedgerCursorSecret,
} from './schema';
import {
  buildLedgerSearchPageStatement,
  normalizeLedgerSearch,
  type LedgerNormalizedSearch,
  type LedgerSearchPagePosition,
} from './search';
import {
  LEDGER_PURGE_SCOPE_SQL,
  LEDGER_SQL,
  type LedgerCountedTable,
} from './statements';
import {
  LEDGER_UNSYNCED_SCOPE,
  ledgerSyncStateAt,
  outboxEventFromRow,
  parseAcknowledgeOutboxInput,
  parseMirrorAudienceInput,
  parseReadOutboxInput,
  parseRebindAccountInput,
  parseScopeRepairInput,
  scopeSyncFromRow,
  takeOutboxBatch,
  toScopeSyncRecord,
  type LedgerStoredScopeSync,
} from './sync';
import { toLedgerTimestamp } from './time';
import type {
  LedgerAcknowledgeOutboxInput,
  LedgerActorRecord,
  LedgerAddEntryInput,
  LedgerBindGlobalScopeInput,
  LedgerBindScopeInput,
  LedgerBindScopeResult,
  LedgerFindGlobalScopeInput,
  LedgerFindScopeInput,
  LedgerGetEntryInput,
  LedgerHandBackEntryInput,
  LedgerListChangesInput,
  LedgerListReceiptKeysInput,
  LedgerOutboxEventRecord,
  LedgerPendingTitleRecord,
  LedgerPublishSummaryInput,
  LedgerPurgeScopeResult,
  LedgerReadOutboxInput,
  LedgerRecordPendingTitleAttemptInput,
  LedgerRebindAccountInput,
  LedgerRebindAccountResult,
  LedgerRebindScopeInput,
  LedgerRecordMirrorAudienceInput,
  LedgerRegisterActorInput,
  LedgerRegisterActorResult,
  LedgerRelatedEntryChange,
  LedgerResolvePendingTitleInput,
  LedgerResolvePendingTitleResult,
  LedgerRepositoryOptions,
  LedgerSchemaStatus,
  LedgerScopeLifecycleState,
  LedgerScopeRecord,
  LedgerScopeSyncRecord,
  LedgerSearchEntriesInput,
  LedgerSearchEntriesResult,
  LedgerSetScopeLifecycleInput,
  LedgerSetScopeRepairInput,
  LedgerSourceAvailabilityResolver,
  LedgerStorageCounts,
  LedgerStoreCommandReceipt,
  LedgerStoreOperation,
  LedgerUpdateEntryInput,
  LedgerWorkSummaryInput,
} from './types';

const SCOPE_SEQUENCE_TEXT = /^(0|[1-9][0-9]{0,15})$/;

const LedgerEntryOutboxPayloadSchema = z.strictObject({
  entry: LedgerEntrySchema,
  mutation: LedgerMutationSchema,
  publication: z.strictObject({ sourceTruncated: z.boolean() }).optional(),
});

/**
 * Archive and restore (including a rebind) are replicated so the mirror can
 * tell archived scopes apart. Retirement is not: the purge that follows
 * removes the scope's outbox, and v1 keeps no cloud tombstone.
 */
type LedgerScopeLifecycleEventKind = 'scope_archived' | 'scope_restored';

type LedgerOutboxKind =
  | 'scope_registered'
  | 'actor_registered'
  | 'entry_revision'
  | LedgerScopeLifecycleEventKind;

const SCOPE_LIFECYCLE_EVENT_KIND: {
  readonly [State in LedgerScopeLifecycleState]: LedgerScopeLifecycleEventKind | null;
} = {
  active: 'scope_restored',
  archived: 'scope_archived',
  retirement_pending: null,
};

interface LedgerOutboxEvent {
  readonly ledgerId: string;
  readonly sequence: number;
  readonly kind: LedgerOutboxKind;
  readonly entryId: string | null;
  readonly entryRevision: number | null;
  readonly occurredAt: string;
  readonly payload: LedgerCanonicalValue;
}

interface LedgerCurrentEntry {
  readonly entryRowid: number;
  /** The scope sequence of the entry's current revision. */
  readonly sequence: number;
  readonly entry: LedgerEntry;
}

/** A search row: the version shown and the sequence it was committed at. */
interface LedgerSearchRow {
  readonly entry: LedgerEntry;
  readonly sequence: number;
  readonly leftOpen: LedgerLeftOpen | undefined;
}

interface LedgerRevisionWrite {
  /** The account the scope syncs to; null for a scope that never does. */
  readonly accountId: string | null;
  readonly entryRowid: number;
  readonly entry: LedgerEntry;
  readonly mutation: LedgerMutation;
  readonly sequence: number;
  readonly receiptKey: LedgerReceiptKey;
  readonly requestHash: string;
  readonly publication: LedgerEntryDraft['publication'];
}

interface LedgerEntryChange {
  readonly status: LedgerStatusChange | null;
  readonly owner: LedgerOwnerChange | null;
  readonly parent: {
    readonly from: string | null;
    readonly to: string | null;
  } | null;
}

type LedgerMutationContext = Pick<
  LedgerUpdateRequest,
  | 'attribution'
  | 'invocationOrigin'
  | 'ownerEligible'
  | 'receiptKey'
  | 'requestHash'
> & {
  readonly leftOpen?: NonNullable<LedgerMutation['leftOpen']>;
};

interface LedgerChildClosePlan {
  readonly choice: 'complete' | 'fail' | 'detach';
  /** Detach targets: the nearest open entries at any depth. */
  readonly detachTargets: readonly LedgerCurrentEntry[];
  /** Open descendants in post-order, used by complete/fail. */
  readonly openDescendants: readonly LedgerCurrentEntry[];
}

function pendingTitleFromRow(row: LedgerSqlRow): LedgerPendingTitleRecord {
  return {
    entryId: rowText(row, 'entry_id'),
    ledgerId: rowText(row, 'ledger_id'),
    createdAt: rowText(row, 'created_at'),
    attempts: rowInteger(row, 'attempts'),
    lastAttemptAt: rowNullableText(row, 'last_attempt_at'),
  };
}

const SYSTEM_HAND_BACK_DETAILS: LedgerEntry['authorDetails'] = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
};

type LedgerHistoryPage = NonNullable<LedgerEntryGetResult['history']>;

function assertScopeWritable(scope: LedgerScopeState): void {
  if (!isLedgerScopeWritable(scope.record.lifecycleState)) {
    throw new LedgerStoreError('SCOPE_RETIRED');
  }
}

/**
 * A global scope has no container lifecycle (see `lifecycle.ts`): every
 * lifecycle command for it fails `FORBIDDEN` on `container.kind`.
 */
function assertContainerLifecycle(scope: LedgerScopeState): void {
  if (!hasLedgerContainerLifecycle(scope.record.scope.container)) {
    throw new LedgerStoreError('FORBIDDEN', { field: 'container.kind' });
  }
}

/** A refused lifecycle move; see `ledgerScopeLifecycleRejection`. */
function lifecycleRejection(from: LedgerScopeLifecycleState): LedgerStoreError {
  const reason = ledgerScopeLifecycleRejection(from);
  return new LedgerStoreError(
    reason,
    reason === 'FORBIDDEN' ? { field: 'ledgerId' } : {},
  );
}

/**
 * A stored projection keeps the scope it was written under, and a rebind may
 * have moved that scope to a restored container since. Reads report the
 * scope's current identity; stored versions and receipts stay as written.
 */
function withCurrentScope(
  entry: LedgerEntry,
  scope: LedgerScopeState,
): LedgerEntry {
  return { ...entry, scope: scope.record.scope };
}

/** A receipt with the other entries its command revised, when there are any. */
function withRelatedChanges(
  receipt: LedgerCommandReceipt,
  related: readonly LedgerEntry[],
): LedgerStoreCommandReceipt {
  if (related.length === 0) return receipt;
  return {
    ...receipt,
    relatedChanges: related.map(
      (entry): LedgerRelatedEntryChange => ({
        entryId: entry.entryId,
        revision: entry.revision,
      }),
    ),
  };
}

function throwIfViolation(violation: LedgerPolicyViolation | null): void {
  if (violation !== null) {
    throw new LedgerStoreError(violation.reason, { field: violation.field });
  }
}

function buildNewEntry(
  scope: LedgerScopeState,
  draft: LedgerEntryDraft,
  entryId: string,
  createdAt: string,
  parentEntryId: string | undefined,
): LedgerEntry {
  return {
    schemaVersion: 1,
    entryId,
    scope: scope.record.scope,
    createdAt,
    updatedAt: createdAt,
    revision: 1,
    author: draft.author,
    authorDetails: draft.authorDetails,
    owner: draft.owner,
    type: draft.type,
    title: draft.title,
    content: draft.content,
    highlights: draft.highlights,
    referenceFiles: draft.referenceFiles,
    status: draft.status,
    origin: draft.origin,
    attribution: draft.attribution,
    ...(draft.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: draft.supersedesEntryId }),
    ...(parentEntryId === undefined ? {} : { parentEntryId }),
  };
}

function updateRejection(
  reason: LedgerUpdateRejection,
  field: string | undefined,
  entry: LedgerEntry,
): LedgerStoreError {
  // Conflicts carry the current projection so the caller can reconsider; a
  // permission failure does not.
  return new LedgerStoreError(reason, {
    field,
    ...(reason === 'FORBIDDEN' ? {} : { currentEntry: entry }),
  });
}

/** `updatedAt` never moves backwards, even if the clock does. */
function laterTimestamp(candidate: string, previous: string): string {
  return Date.parse(candidate) >= Date.parse(previous) ? candidate : previous;
}

function pageLimit(
  value: number | undefined,
  fallback: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new LedgerStoreError('INVALID_INPUT', { field, limit: max });
  }
  return value;
}

function parseScopeSequence(value: string): number | null {
  if (!SCOPE_SEQUENCE_TEXT.test(value)) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function cursorExpired(field: string): LedgerStoreError {
  return new LedgerStoreError('CURSOR_EXPIRED', { field });
}

function availableSource(): LedgerSourceAvailability {
  return 'available';
}

function sourceAvailability(
  resolver: LedgerSourceAvailabilityResolver | undefined,
  entry: LedgerEntry,
): LedgerSourceAvailability {
  return (resolver ?? availableSource)(entry);
}

/**
 * The local Agent Ledger store: one exclusive, single-writer `node:sqlite`
 * connection.
 *
 * Every command (`bindScope`, `bindGlobalScope`, `registerActor`, `addEntry`, `updateEntry`,
 * `publishSummary`, and the lifecycle commands `setScopeLifecycle`,
 * `rebindScope` and `purgeScope`) runs in exactly one `BEGIN IMMEDIATE`
 * transaction and commits before it returns; any failure rolls the whole
 * command back. Entry commands look up their idempotency receipt before any
 * other check, so an exact replay returns the stored receipt even after the
 * entry became terminal or its scope was archived or rebound.
 *
 * Every method is synchronous, so the host must run the repository off the
 * Electron main event loop (the desktop uses a storage worker thread). Nothing
 * here logs; errors are `LedgerStoreError`s whose messages carry no entry
 * text, paths or identifiers.
 */
export class LedgerRepository {
  /** Schema state found at open. */
  readonly schema: LedgerSchemaStatus;
  /**
   * The writer authority minted with this database. The host binds scopes
   * and registers actors under it, so every ID this store issues is
   * qualified by the database that wrote it.
   */
  readonly authorityId: string;
  private database: DatabaseSync | null;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly beforeCommit: LedgerRepositoryOptions['beforeCommit'];
  private readonly cursorSecret: Buffer;
  private readonly statements = new Map<string, StatementSync>();
  private activeOperation: LedgerStoreOperation | null = null;

  private constructor(
    database: DatabaseSync,
    options: LedgerRepositoryOptions,
    schema: LedgerSchemaStatus,
    cursorSecret: Buffer,
    authorityId: string,
  ) {
    this.database = database;
    this.authorityId = authorityId;
    this.now = options.now ?? ((): Date => new Date());
    this.randomUUID = options.randomUUID ?? ((): string => cryptoRandomUUID());
    this.beforeCommit = options.beforeCommit;
    this.schema = schema;
    this.cursorSecret = cursorSecret;
  }

  /**
   * Opens (creating and migrating when needed) the database at
   * `options.databasePath` and takes its exclusive write lock.
   *
   * Fails with `WRITER_UNAVAILABLE` when another connection holds the
   * database past `openBusyTimeoutMs`, having written nothing, and with
   * `STORAGE_UNAVAILABLE` for other open failures (the file is never
   * recreated). A database from a newer build opens read-only: reads work
   * and every command fails `UNSUPPORTED_SCHEMA`.
   */
  static open(options: LedgerRepositoryOptions): LedgerRepository {
    const now = options.now ?? ((): Date => new Date());
    const database = openExclusiveLedgerDatabase(
      options.databasePath,
      options.openBusyTimeoutMs ?? LEDGER_DEFAULT_OPEN_BUSY_TIMEOUT_MS,
    );
    try {
      const migration = migrateLedgerSchema(database, {
        createdAt: toLedgerTimestamp(now()),
      });
      if (migration.newer) database.exec('PRAGMA query_only = ON');
      const secret =
        readLedgerCursorSecret(database) ??
        (migration.newer ? createEphemeralLedgerCursorSecret() : null);
      if (secret === null) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'cursor_secret',
        });
      }
      const authorityId = readLedgerAuthorityId(database);
      if (authorityId === null) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'authority_id',
        });
      }
      return new LedgerRepository(
        database,
        options,
        { version: migration.version, readOnly: migration.newer },
        secret,
        authorityId,
      );
    } catch (error) {
      closeQuietly(database);
      throw toLedgerStoreError(error, 'STORAGE_UNAVAILABLE');
    }
  }

  get isOpen(): boolean {
    return this.database !== null;
  }

  /** Closes the connection and releases the lock. Safe to call twice. */
  close(): void {
    const database = this.database;
    if (database === null) return;
    if (this.activeOperation !== null) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'close_during_command',
      });
    }
    this.database = null;
    this.statements.clear();
    try {
      database.close();
    } catch (error) {
      throw toLedgerStoreError(error, 'STORAGE_UNAVAILABLE');
    }
  }

  /**
   * Returns the ledger bound to a container incarnation, minting it on first
   * use. The key is the container tuple plus the container's creation time;
   * a reused container ID with a different creation time gets a new ledger.
   * The account is recorded only when the ledger is minted and is never
   * rebound here. Binding an existing ledger under another authority fails
   * `FORBIDDEN`. A global container fails `INVALID_INPUT` on
   * `container.kind`: only `bindGlobalScope` binds one.
   */
  bindScope(input: LedgerBindScopeInput): LedgerBindScopeResult {
    return this.command('bindScope', (): LedgerBindScopeResult => {
      const binding = parseLedgerScopeBinding(input);
      const existing = this.selectScopeByIdentity(binding);
      if (existing === null) {
        return { scope: this.insertScope(binding), created: true };
      }
      if (existing.record.scope.authorityId !== binding.authorityId) {
        throw new LedgerStoreError('FORBIDDEN', { field: 'authorityId' });
      }
      return { scope: existing.record, created: false };
    });
  }

  /**
   * Looks up a container incarnation's ledger without minting one. A global
   * Ledger is found here by the incarnation its binding minted.
   */
  findScope(input: LedgerFindScopeInput): LedgerScopeRecord | null {
    return this.query(
      (): LedgerScopeRecord | null =>
        this.selectScopeByIdentity(
          parseLedgerScopeIdentity(input.container, input.containerCreatedAt),
        )?.record ?? null,
    );
  }

  /**
   * Returns the global Ledger of one owner for one account (null: signed
   * out), minting it on first use. The binding, not the container, is the
   * identity: each account, and signed-out use, gets its own Ledger of each
   * owner, so two accounts never share one. A new Ledger's container creation
   * time is minted from the clock and moved forward a millisecond at a time
   * past any incarnation of the owner's container that already has it, so a
   * repeated or regressed clock still mints a new incarnation. The lookup,
   * the scope, its registration event and the binding commit together.
   * Binding an existing ledger under another authority fails `FORBIDDEN`.
   */
  bindGlobalScope(input: LedgerBindGlobalScopeInput): LedgerBindScopeResult {
    return this.command('bindGlobalScope', (): LedgerBindScopeResult => {
      const binding = parseLedgerGlobalScopeBinding(input);
      const existing = this.selectGlobalScope(binding);
      if (existing !== null) {
        if (existing.record.scope.authorityId !== binding.authorityId) {
          throw new LedgerStoreError('FORBIDDEN', { field: 'authorityId' });
        }
        return { scope: existing.record, created: false };
      }
      const scope = this.insertScope({
        ...binding,
        containerCreatedAt: this.mintIncarnation(binding.columns),
      });
      this.prepare(LEDGER_SQL.insertGlobalBinding).run(
        binding.ownerKey,
        binding.accountKey,
        scope.scope.ledgerId,
      );
      return { scope, created: true };
    });
  }

  /** Looks up one owner's global Ledger for one account without minting one. */
  findGlobalScope(input: LedgerFindGlobalScopeInput): LedgerScopeRecord | null {
    return this.query(
      (): LedgerScopeRecord | null =>
        this.selectGlobalScope(parseLedgerGlobalScopeKey(input))?.record ??
        null,
    );
  }

  getScope(ledgerId: string): LedgerScopeRecord | null {
    return this.query(
      (): LedgerScopeRecord | null =>
        this.selectScope(ledgerId)?.record ?? null,
    );
  }

  /**
   * Every scope, in the order the scopes were minted, global ones included:
   * callers that follow container lifecycles skip those whose container has
   * none (`hasLedgerContainerLifecycle`).
   */
  listScopes(): LedgerScopeRecord[] {
    return this.query((): LedgerScopeRecord[] =>
      this.prepare(LEDGER_SQL.listScopes)
        .all()
        .map((row) => scopeFromRow(row).record),
    );
  }

  /**
   * The scopes bound to any incarnation of one container, in the order the
   * scopes were minted. A scope rebound to a restored container is listed
   * under that container, no longer under the one it was minted for. For a
   * global container these are every account's global Ledger of that owner,
   * bound or not.
   */
  findContainerScopes(container: LedgerContainer): LedgerScopeRecord[] {
    return this.query((): LedgerScopeRecord[] => {
      const columns = parseLedgerContainerColumns(container);
      return this.prepare(LEDGER_SQL.listContainerScopes)
        .all(columns.kind, columns.parentId, columns.itemId)
        .map((row) => scopeFromRow(row).record);
    });
  }

  /** A stable, cross-scope page of operation and top-level task rollups. */
  listRollups(input: LedgerRollupsInput): LedgerRollupsListResult {
    return this.query(() =>
      listLedgerRollups(input, {
        prepare: (sql) => this.prepare(sql),
        cursorSecret: this.cursorSecret,
        schemaVersion: this.schema.version,
        now: this.now,
      }),
    );
  }

  /**
   * Counts the entries authored, currently owned or handed back by the
   * bounded actor set. One indexed SQL statement performs the membership
   * unions, all-status counts and limited open-entry projection.
   */
  getWorkSummary(input: LedgerWorkSummaryInput): LedgerWorkSummaryGetResult {
    return this.query((): LedgerWorkSummaryGetResult => {
      const request = normalizeLedgerWorkSummaryInput(input);
      const rows = this.prepare(LEDGER_SQL.getWorkSummary).all(
        JSON.stringify(request.actorIds),
        request.ledgerId,
        request.ledgerId,
        request.ledgerId,
        request.ledgerId,
      );
      const first = rows[0];
      if (first === undefined) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'malformed_record',
        });
      }
      const open: unknown[] = [];
      for (const row of rows) {
        const entryId = rowNullableText(row, 'open_entry_id');
        if (entryId === null) continue;
        open.push({
          entryId,
          status: rowText(row, 'open_status'),
          owner: {
            actorId: rowText(row, 'open_owner_actor_id'),
            kind: rowText(row, 'open_owner_kind'),
            authorityId: rowText(row, 'open_owner_authority_id'),
          },
        });
      }
      const result = LedgerWorkSummaryGetResultSchema.safeParse({
        counts: parseStoredJson(rowText(first, 'counts_json')),
        open,
        openTotal: rowInteger(first, 'open_total'),
      });
      if (!result.success) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'malformed_record',
        });
      }
      return result.data;
    });
  }

  /**
   * Moves a scope along its lifecycle (see `lifecycle.ts`): `archived`,
   * `active` again, or `retirement_pending`. Requesting the current state
   * changes nothing. Archive and restore append a replication event;
   * retirement does not. Fails, changing nothing, with `NOT_FOUND` for an
   * unknown scope, `SCOPE_RETIRED` for a move out of `retirement_pending`,
   * and `FORBIDDEN` on `container.kind` for any request about a global scope.
   */
  setScopeLifecycle(input: LedgerSetScopeLifecycleInput): LedgerScopeRecord {
    return this.command('setScopeLifecycle', (): LedgerScopeRecord => {
      const change = parseLedgerScopeLifecycleChange(input);
      const scope = this.requireScope(change.ledgerId);
      assertContainerLifecycle(scope);
      const from = scope.record.lifecycleState;
      switch (ledgerScopeLifecycleStep(from, change.state)) {
        case 'unchanged':
          return scope.record;
        case 'forbidden':
          throw lifecycleRejection(from);
        case 'transition':
          this.prepare(LEDGER_SQL.updateScopeLifecycle).run(
            change.state,
            scope.ledgerId,
          );
          return this.recordScopeLifecycleEvent(scope.ledgerId, change.state);
      }
    });
  }

  /**
   * Points an archived scope at the restored incarnation of its container and
   * makes it active again. Its ledger ID, entries, revisions, mutations,
   * receipts and actors stay; entry reads report the new container, while
   * stored versions and receipts are not rewritten, so an exact replay still
   * returns its original response. The old incarnation no longer has a
   * ledger, and repeating a completed rebind changes nothing.
   *
   * Fails, changing nothing, with `NOT_FOUND` for an unknown scope,
   * `INVALID_INPUT` for another container kind, `SCOPE_RETIRED` for a
   * retiring scope, and `FORBIDDEN` for an active scope or for an incarnation
   * that already has a ledger of its own. A global scope is never moved: it
   * fails `FORBIDDEN` on `container.kind`.
   */
  rebindScope(input: LedgerRebindScopeInput): LedgerScopeRecord {
    return this.command('rebindScope', (): LedgerScopeRecord => {
      const rebinding = parseLedgerScopeRebinding(input);
      const scope = this.requireScope(rebinding.ledgerId);
      assertContainerLifecycle(scope);
      const from = scope.record.lifecycleState;
      const occupant = this.selectScopeByIdentity(rebinding);
      if (
        occupant?.ledgerId === scope.ledgerId &&
        isLedgerScopeWritable(from)
      ) {
        return scope.record;
      }
      if (rebinding.columns.kind !== scope.record.scope.container.kind) {
        throw new LedgerStoreError('INVALID_INPUT', {
          field: 'container.kind',
        });
      }
      if (!canRebindLedgerScope(from)) throw lifecycleRejection(from);
      if (occupant !== null && occupant.ledgerId !== scope.ledgerId) {
        throw new LedgerStoreError('FORBIDDEN', { field: 'container' });
      }
      this.prepare(LEDGER_SQL.rebindScope).run(
        rebinding.columns.parentId,
        rebinding.columns.itemId,
        rebinding.containerCreatedAt,
        'active',
        scope.ledgerId,
      );
      return this.recordScopeLifecycleEvent(scope.ledgerId, 'active');
    });
  }

  /**
   * Removes a `retirement_pending` scope and every row that belongs to it:
   * search rows, entry versions, mutations, receipts, entries, outbox events,
   * actors and the scope itself. Returns `purged: false` for an unknown scope.
   * A live scope fails `FORBIDDEN`, changing nothing: it must be retired
   * first. A global scope is never retired, so it always fails `FORBIDDEN`,
   * on `container.kind`. Nothing drains the outbox yet, so unsent events go
   * with the scope.
   */
  purgeScope(ledgerId: string): LedgerPurgeScopeResult {
    return this.command('purgeScope', (): LedgerPurgeScopeResult => {
      const scope = this.selectScope(parseLedgerIdInput(ledgerId));
      if (scope === null) return { purged: false };
      assertContainerLifecycle(scope);
      const from = scope.record.lifecycleState;
      if (!canPurgeLedgerScope(from)) throw lifecycleRejection(from);
      for (const sql of LEDGER_PURGE_SCOPE_SQL) {
        this.prepare(sql).run(scope.ledgerId);
      }
      return { purged: true };
    });
  }

  /** Every scope with its sync bookkeeping, in the order they were minted. */
  listSyncScopes(): LedgerScopeSyncRecord[] {
    return this.query((): LedgerScopeSyncRecord[] => {
      const stored = new Map<string, LedgerStoredScopeSync>(
        this.prepare(LEDGER_SQL.listScopeSync)
          .all()
          .map((row: LedgerSqlRow): [string, LedgerStoredScopeSync] => [
            rowText(row, 'ledger_id'),
            scopeSyncFromRow(row),
          ]),
      );
      return this.prepare(LEDGER_SQL.listScopes)
        .all()
        .map((row: LedgerSqlRow): LedgerScopeSyncRecord => {
          const scope = scopeFromRow(row);
          return toScopeSyncRecord(
            scope.record,
            stored.get(scope.ledgerId) ?? LEDGER_UNSYNCED_SCOPE,
          );
        });
    });
  }

  /** One scope's sync bookkeeping; null for a scope this store does not know. */
  getScopeSync(ledgerId: string): LedgerScopeSyncRecord | null {
    return this.query((): LedgerScopeSyncRecord | null => {
      const scope = this.selectScope(parseLedgerIdInput(ledgerId));
      return scope === null
        ? null
        : toScopeSyncRecord(scope.record, this.selectScopeSync(scope.ledgerId));
    });
  }

  /**
   * The scope's outbox events after a sequence, oldest first: at most `limit`
   * of them, and as many as fit `maxPayloadBytes`. Events the mirror already
   * acknowledged are gone, so a read starts after the acknowledged sequence.
   */
  readOutbox(input: LedgerReadOutboxInput): LedgerOutboxEventRecord[] {
    return this.query((): LedgerOutboxEventRecord[] => {
      const read = parseReadOutboxInput(input);
      const scope = this.requireScope(read.ledgerId);
      const firstPendingRow = this.prepare(
        LEDGER_SQL.selectFirstPendingTitleSequence,
      ).get(scope.ledgerId);
      const firstPendingSequence =
        firstPendingRow === undefined ||
        firstPendingRow.scope_sequence === null ||
        firstPendingRow.scope_sequence === undefined
          ? null
          : rowInteger(firstPendingRow, 'scope_sequence');
      if (
        firstPendingSequence !== null &&
        read.afterSequence >= firstPendingSequence
      ) {
        return [];
      }
      const events = this.prepare(LEDGER_SQL.selectOutbox)
        .all(scope.ledgerId, read.afterSequence, read.limit)
        .map(outboxEventFromRow)
        .filter(
          (event) =>
            firstPendingSequence === null ||
            Number(event.scopeSequence) < firstPendingSequence,
        );
      return takeOutboxBatch(events, read.maxPayloadBytes);
    });
  }

  /**
   * Records that the mirror holds every event up to `sequence`, and drops
   * those events from the outbox. An acknowledgment never moves backwards,
   * and one beyond the scope's own sequence fails `INVALID_INPUT`: the mirror
   * cannot hold what this store never wrote.
   */
  acknowledgeOutbox(
    input: LedgerAcknowledgeOutboxInput,
  ): LedgerScopeSyncRecord {
    return this.command('acknowledgeOutbox', (): LedgerScopeSyncRecord => {
      const acknowledgment = parseAcknowledgeOutboxInput(input);
      const scope = this.requireScope(acknowledgment.ledgerId);
      if (acknowledgment.sequence > scope.sequence) {
        throw new LedgerStoreError('INVALID_INPUT', { field: 'sequence' });
      }
      this.prepare(LEDGER_SQL.acknowledgeScope).run(
        scope.ledgerId,
        acknowledgment.sequence,
        this.timestamp(),
      );
      this.prepare(LEDGER_SQL.deleteAcknowledgedOutbox).run(
        scope.ledgerId,
        scope.ledgerId,
      );
      return this.scopeSyncRecord(scope);
    });
  }

  /** Remembers the audience the mirror answered a registration with. */
  recordMirrorAudience(
    input: LedgerRecordMirrorAudienceInput,
  ): LedgerScopeSyncRecord {
    return this.command('recordMirrorAudience', (): LedgerScopeSyncRecord => {
      const confirmation = parseMirrorAudienceInput(input);
      const scope = this.requireScope(confirmation.ledgerId);
      const confirmedAt = this.timestamp();
      this.prepare(LEDGER_SQL.recordMirrorAudience).run(
        scope.ledgerId,
        toCanonicalJson(confirmation.audience),
        confirmedAt,
        confirmedAt,
      );
      return this.scopeSyncRecord(scope);
    });
  }

  /**
   * Marks a scope as needing repair, so its unsent revisions say so and the
   * host stops pushing it, or clears the mark with a null reason.
   */
  setScopeRepair(input: LedgerSetScopeRepairInput): LedgerScopeSyncRecord {
    return this.command('setScopeRepair', (): LedgerScopeSyncRecord => {
      const repair = parseScopeRepairInput(input);
      const scope = this.requireScope(repair.ledgerId);
      this.prepare(LEDGER_SQL.setScopeRepair).run(
        scope.ledgerId,
        repair.reason,
        this.timestamp(),
      );
      return this.scopeSyncRecord(scope);
    });
  }

  /**
   * Moves every scope bound to one account to another. Only a
   * server-confirmed merge of a guest account calls it; nothing else ever
   * changes the account a scope syncs to. Events already written still name
   * the account they were written under.
   *
   * Global bindings move with their account, in the same transaction. Where
   * the destination already has a global Ledger of the same owner, that one
   * keeps receiving new entries and only the guest's redundant binding is
   * removed: the guest's Ledger keeps its entries, actors, receipts and
   * outbox, addressed by its ledger ID. Signed-out use has no account, so a
   * merge never moves it (LD02).
   */
  rebindAccount(input: LedgerRebindAccountInput): LedgerRebindAccountResult {
    return this.command('rebindAccount', (): LedgerRebindAccountResult => {
      const rebinding = parseRebindAccountInput(input);
      const fromKey = ledgerGlobalAccountKey(rebinding.fromAccountId);
      const toKey = ledgerGlobalAccountKey(rebinding.toAccountId);
      this.prepare(LEDGER_SQL.deleteRedundantGlobalBindings).run(
        fromKey,
        toKey,
      );
      this.prepare(LEDGER_SQL.rebindGlobalBindings).run(toKey, fromKey);
      const result = this.prepare(LEDGER_SQL.rebindAccount).run(
        rebinding.toAccountId,
        rebinding.fromAccountId,
      );
      return { rebound: Number(result.changes) };
    });
  }

  /**
   * Registers an actor in a ledger, or returns the one already registered
   * under the same origin key. The display name is a snapshot taken at first
   * registration. A repeat with another kind fails `INVALID_INPUT`, and with
   * another authority `FORBIDDEN`. New actors require an active scope.
   */
  registerActor(input: LedgerRegisterActorInput): LedgerRegisterActorResult {
    return this.command('registerActor', (): LedgerRegisterActorResult => {
      const registration = parseLedgerActorRegistration(input);
      const scope = this.requireScope(input.ledgerId);
      const existing = this.selectActorByOriginKey(
        scope.ledgerId,
        registration.originKey,
      );
      if (existing !== null) {
        return {
          actor: assertSameLedgerActorRegistration(existing, registration),
          created: false,
        };
      }
      assertScopeWritable(scope);
      return {
        actor: this.insertActor(scope.ledgerId, registration),
        created: true,
      };
    });
  }

  /** Every actor registered in a ledger, in registration order. */
  listActors(ledgerId: string): LedgerActorRecord[] {
    return this.query((): LedgerActorRecord[] => {
      const scope = this.requireScope(ledgerId);
      return this.prepare(LEDGER_SQL.listActors)
        .all(scope.ledgerId)
        .map(actorFromRow);
    });
  }

  /** Every entry whose local provisional title still needs generation. */
  listPendingTitles(): LedgerPendingTitleRecord[] {
    return this.query((): LedgerPendingTitleRecord[] =>
      this.prepare(LEDGER_SQL.listPendingTitles).all().map(pendingTitleFromRow),
    );
  }

  /**
   * Creates a Ledger entry. Author, owner,
   * details, origin and attribution are host-resolved; `params` are the
   * caller's validated request.
   */
  addEntry(input: LedgerAddEntryInput): LedgerStoreCommandReceipt {
    return this.command(
      'addEntry',
      (): LedgerStoreCommandReceipt =>
        this.createEntry(input.ledgerId, normalizeAddEntryRequest(input)),
    );
  }

  /** Creates the SUMMARY/INFO entry for one Summary snapshot. */
  publishSummary(input: LedgerPublishSummaryInput): LedgerStoreCommandReceipt {
    return this.command(
      'publishSummary',
      (): LedgerStoreCommandReceipt =>
        this.createEntry(input.ledgerId, normalizeSummaryRequest(input)),
    );
  }

  /**
   * Which of the given idempotency keys already hold a receipt for the
   * operation in the ledger, from any caller, in the order given. Summary
   * reconciliation uses it to skip snapshots whose publication committed. A
   * ledger this store does not know holds none.
   */
  listReceiptKeys(input: LedgerListReceiptKeysInput): string[] {
    return this.query((): string[] => {
      const request = normalizeReceiptKeysRequest(input);
      if (request.idempotencyKeys.length === 0) return [];
      const stored = new Set(
        this.prepare(LEDGER_SQL.selectReceiptKeys)
          .all(
            request.ledgerId,
            request.operation,
            JSON.stringify(request.idempotencyKeys),
          )
          .map((row) => rowText(row, 'idempotency_key')),
      );
      return request.idempotencyKeys.filter((key) => stored.has(key));
    });
  }

  /** Increments a local title-generation attempt, or returns null if resolved. */
  recordPendingTitleAttempt(
    input: LedgerRecordPendingTitleAttemptInput,
  ): LedgerPendingTitleRecord | null {
    return this.command(
      'recordPendingTitleAttempt',
      (): LedgerPendingTitleRecord | null => {
        const entryId = parseLedgerInput(
          LedgerUuidSchema,
          input.entryId,
          'entryId',
        );
        const updated = this.prepare(LEDGER_SQL.updatePendingTitleAttempt).run(
          this.timestamp(),
          entryId,
        );
        if (Number(updated.changes) === 0) return null;
        const row = this.prepare(LEDGER_SQL.selectPendingTitle).get(entryId);
        return row === undefined ? null : pendingTitleFromRow(row);
      },
    );
  }

  /**
   * Completes an Add entry's local title workflow without creating a revision.
   * Invalid, absent and unchanged titles clear the marker without rewriting.
   * An entry whose first revision has reached the mirror also keeps its title:
   * changing it would make the mirror's canonical history diverge.
   */
  resolvePendingTitle(
    input: LedgerResolvePendingTitleInput,
  ): LedgerResolvePendingTitleResult {
    return this.command(
      'resolvePendingTitle',
      (): LedgerResolvePendingTitleResult => {
        const entryId = parseLedgerInput(
          LedgerUuidSchema,
          input.entryId,
          'entryId',
        );
        const pendingRow = this.prepare(LEDGER_SQL.selectPendingTitle).get(
          entryId,
        );
        if (pendingRow === undefined) {
          return { resolved: false, entry: null };
        }
        const pending = pendingTitleFromRow(pendingRow);
        const currentRow = this.prepare(LEDGER_SQL.selectEntry).get(
          pending.ledgerId,
          entryId,
        );
        if (currentRow === undefined) {
          this.prepare(LEDGER_SQL.deletePendingTitle).run(entryId);
          return { resolved: true, entry: null };
        }
        const scope = this.requireScope(pending.ledgerId);
        const current = this.requireEntry(scope, entryId);
        const normalizedTitle =
          typeof input.title === 'string'
            ? input.title.replace(/\s+/g, ' ').trim()
            : null;
        const parsedTitle =
          normalizedTitle === null
            ? null
            : LedgerTitleSchema.safeParse(normalizedTitle);
        const title =
          parsedTitle !== null && parsedTitle.success ? parsedTitle.data : null;
        let resultEntry = current.entry;

        if (
          title !== null &&
          title !== current.entry.title &&
          !this.isEntryTitleAcknowledged(scope.ledgerId, entryId)
        ) {
          resultEntry = this.rewritePendingTitle(scope, current, title);
        }

        this.prepare(LEDGER_SQL.deletePendingTitle).run(entryId);
        return { resolved: true, entry: resultEntry };
      },
    );
  }

  /**
   * Changes an entry's status and/or owner under a revision check. Terminal
   * entries reject every change, including exact no-ops; an open-entry
   * no-op returns `changed: false` and still records its receipt. Children
   * closed or detached with it and an operation it auto-starts are listed
   * in `relatedChanges`.
   */
  updateEntry(input: LedgerUpdateEntryInput): LedgerStoreCommandReceipt {
    return this.command('updateEntry', (): LedgerStoreCommandReceipt => {
      const request = normalizeUpdateEntryRequest(input);
      const replay = this.findReplay(request.receiptKey, request.requestHash);
      if (replay !== null) return replay;
      const scope = this.requireWritableScope(input.ledgerId);
      this.assertUpdateCaller(scope, request);
      const current = this.requireEntry(scope, request.params.entryId);
      const decision = evaluateLedgerUpdate({
        current: current.entry,
        expectedRevision: request.params.expectedRevision,
        requestedStatus: request.params.status,
        requestedOwner: request.newOwner ?? undefined,
        requestedParentEntryId: request.params.parentEntryId,
        attribution: request.attribution,
        delegateOwnerActorIds: request.delegateOwnerActorIds,
        mayUpdateAnyOpenEntry: request.mayUpdateAnyOpenEntry,
      });
      switch (decision.kind) {
        case 'reject':
          throw updateRejection(decision.reason, decision.field, current.entry);
        case 'noop':
          return this.recordNoop(
            scope,
            current,
            request.receiptKey,
            request.requestHash,
          );
        case 'change': {
          if (decision.parent !== null) {
            this.assertValidParent(
              scope,
              current.entry.type,
              decision.parent.to,
              current.entry.entryId,
            );
          }
          const closeChoice = this.prepareChildClose(
            scope,
            current,
            request,
            decision.status?.to,
          );
          const related =
            closeChoice === null
              ? []
              : this.applyChildClose(scope, request, closeChoice);
          const receipt = this.applyChange(scope, current, request, decision);
          if (decision.status?.to === 'IN_PROGRESS') {
            const started = this.autoStartOperation(
              scope,
              receipt.entry,
              request,
            );
            if (started !== null) related.push(started);
          }
          return withRelatedChanges(receipt, related);
        }
      }
    });
  }

  /**
   * Hands an ended session's open TASK or ACTION back to a registered owner.
   * Revision, owner and transition-time checks run in the same transaction as
   * the ordinary version, mutation, receipt and outbox writes. Like every
   * write, it refuses an archived or retiring scope: the mirror takes no
   * entries in an archived scope either.
   */
  handBackEntry(input: LedgerHandBackEntryInput): LedgerStoreCommandReceipt {
    return this.command('handBackEntry', (): LedgerStoreCommandReceipt => {
      const request: LedgerHandBackRequest =
        normalizeHandBackEntryRequest(input);
      const replay = this.findReplay(request.receiptKey, request.requestHash);
      if (replay !== null) return replay;

      const scope = this.requireWritableScope(request.ledgerId);
      const current = this.requireEntry(scope, request.entryId);
      if (current.entry.revision !== request.expectedRevision) {
        throw updateRejection(
          'REVISION_CONFLICT',
          'expectedRevision',
          current.entry,
        );
      }

      this.requireEligibleOwner(scope.ledgerId, request.newOwner, true);
      const target = this.selectActorById(
        scope.ledgerId,
        request.newOwner.actorId,
      );
      if (target === null) {
        throw new LedgerStoreError('OWNER_UNAVAILABLE', { field: 'owner' });
      }

      if (
        current.entry.owner.actorId !== request.endedActorId ||
        (current.entry.type !== 'TASK' && current.entry.type !== 'ACTION') ||
        !isLedgerEntryOpen(current.entry.status) ||
        Date.parse(current.entry.updatedAt) >
          Date.parse(request.transitionAt) ||
        sameLedgerActor(current.entry.owner, target.actor)
      ) {
        return this.recordNoop(
          scope,
          current,
          request.receiptKey,
          request.requestHash,
        );
      }

      const endedActor = this.selectActorById(
        scope.ledgerId,
        request.endedActorId,
      );
      if (
        endedActor === null ||
        !sameLedgerActor(endedActor.actor, current.entry.owner)
      ) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'handback_ended_actor_missing',
        });
      }

      const attribution: LedgerAttribution = {
        kind: 'system',
        effectiveActor: endedActor.actor,
        recordedBy: endedActor.actor,
        executorDetails: SYSTEM_HAND_BACK_DETAILS,
      };
      return this.applyChange(
        scope,
        current,
        {
          attribution,
          invocationOrigin: current.entry.origin,
          ownerEligible: true,
          receiptKey: request.receiptKey,
          requestHash: request.requestHash,
          leftOpen: request.reason,
        },
        {
          status: null,
          owner: { from: current.entry.owner, to: target.actor },
          parent: null,
        },
      );
    });
  }

  /** The current entry, its source availability and optional history. */
  getEntry(input: LedgerGetEntryInput): LedgerEntryGetResult {
    return this.query((): LedgerEntryGetResult => {
      const scope = this.requireScope(input.ledgerId);
      const current = this.requireEntry(scope, input.entryId);
      const history =
        input.includeHistory === true || input.historyCursor !== undefined
          ? this.readHistory(input, current)
          : null;
      const titlePending = this.selectPendingTitle(current.entry.entryId);
      return {
        entry: current.entry,
        sourceAvailability: sourceAvailability(
          input.resolveSourceAvailability,
          current.entry,
        ),
        ...(titlePending === null ? {} : { titlePending: true }),
        history,
        syncState: this.syncStateAt(scope, current.sequence),
      };
    });
  }

  /**
   * One page of a snapshot search. The first page captures the scope
   * sequence as the watermark; later pages read each entry's latest version
   * at or below it, so entries that change between pages are neither
   * dropped nor duplicated.
   */
  searchEntries(input: LedgerSearchEntriesInput): LedgerSearchEntriesResult {
    return this.query((): LedgerSearchEntriesResult => {
      const scope = this.requireScope(input.ledgerId);
      const search = normalizeLedgerSearch(input);
      const position: LedgerSearchPagePosition =
        input.cursor === undefined
          ? { watermark: scope.sequence, after: null }
          : this.resolveSearchCursor(input.cursor, scope, search);
      const rows = this.readSearchPage(scope, search, position);
      const page = rows.slice(0, search.limit);
      const hasMore = rows.length > search.limit;
      const last = page[page.length - 1];
      const sync = this.selectScopeSync(scope.ledgerId);
      const pendingTitleEntryIds = new Set(
        page.length === 0
          ? []
          : this.prepare(LEDGER_SQL.selectPendingTitleEntryIds)
              .all(JSON.stringify(page.map((row) => row.entry.entryId)))
              .map((row) => rowText(row, 'entry_id')),
      );
      return {
        entries: page.map((row: LedgerSearchRow) => ({
          ...toLedgerEntrySearchItem(
            row.entry,
            sourceAvailability(input.resolveSourceAvailability, row.entry),
            ledgerSyncStateAt(scope.record.accountId, row.sequence, sync),
            pendingTitleEntryIds.has(row.entry.entryId),
          ),
          ...(row.leftOpen === undefined ? {} : { leftOpen: row.leftOpen }),
        })),
        origins: page.map((row: LedgerSearchRow) => row.entry.origin),
        nextCursor:
          hasMore && last !== undefined
            ? this.searchCursor(scope.ledgerId, search, position, last.entry)
            : null,
        hasMore,
        watermark: String(position.watermark),
      };
    });
  }

  /**
   * Entry revisions committed after `afterSequence`, oldest first. Scope and
   * actor events share the sequence but are not listed; `nextSequence`
   * skips past them once the listing is complete.
   */
  listChanges(input: LedgerListChangesInput): LedgerChangesListResult {
    return this.query((): LedgerChangesListResult => {
      const scope = this.requireScope(input.ledgerId);
      const limit = pageLimit(
        input.limit,
        LEDGER_LIMITS.changesPageDefault,
        LEDGER_LIMITS.changesPageMax,
        'limit',
      );
      const after = parseLedgerInput(
        LedgerSequenceSchema,
        input.afterSequence,
        'afterSequence',
      );
      if (BigInt(after) > BigInt(scope.sequence)) {
        throw cursorExpired('afterSequence');
      }
      const rows = this.prepare(LEDGER_SQL.selectChanges).all(
        scope.ledgerId,
        Number(after),
        limit + 1,
      );
      const changes = rows.slice(0, limit).map((row) => ({
        sequence: String(rowInteger(row, 'scope_sequence')),
        entryId: rowText(row, 'entry_id'),
        revision: rowInteger(row, 'revision'),
      }));
      const hasMore = rows.length > limit;
      const last = changes[changes.length - 1];
      return {
        changes,
        nextSequence:
          hasMore && last !== undefined ? last.sequence : scope.record.sequence,
        hasMore,
      };
    });
  }

  /** Content-free row counts for health diagnostics. */
  getStorageCounts(): LedgerStorageCounts {
    return this.query(
      (): LedgerStorageCounts => ({
        scopes: this.countRows('ledger_scopes'),
        actors: this.countRows('ledger_actors'),
        entries: this.countRows('ledger_entries'),
        entryVersions: this.countRows('ledger_entry_versions'),
        mutations: this.countRows('ledger_mutations'),
        receipts: this.countRows('ledger_command_receipts'),
        outbox: this.countRows('ledger_outbox'),
        searchRows: this.countRows('ledger_search'),
      }),
    );
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === null) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'closed',
      });
    }
    return this.database;
  }

  private prepare(sql: string): StatementSync {
    const database = this.requireDatabase();
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const statement = database.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  /** Runs one command in exactly one `BEGIN IMMEDIATE` transaction. */
  private command<Result>(
    operation: LedgerStoreOperation,
    body: () => Result,
  ): Result {
    const database = this.requireDatabase();
    if (this.schema.readOnly) {
      throw new LedgerStoreError('UNSUPPORTED_SCHEMA');
    }
    if (this.activeOperation !== null) {
      // Commands never nest: the single connection serializes them.
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'reentrant_command',
      });
    }
    this.activeOperation = operation;
    try {
      database.exec('BEGIN IMMEDIATE');
      const result = body();
      this.beforeCommit?.({ operation });
      database.exec('COMMIT');
      return result;
    } catch (error) {
      rollbackQuietly(database);
      throw toLedgerStoreError(error, 'STORAGE_UNAVAILABLE');
    } finally {
      this.activeOperation = null;
    }
  }

  private query<Result>(body: () => Result): Result {
    this.requireDatabase();
    try {
      return body();
    } catch (error) {
      throw this.queryError(error);
    }
  }

  private queryError(error: unknown): LedgerStoreError {
    const mapped = toLedgerStoreError(error, 'STORAGE_UNAVAILABLE');
    // A newer schema's rows may not parse; report the schema, not a fault.
    if (this.schema.readOnly && mapped.reason === 'STORAGE_UNAVAILABLE') {
      return new LedgerStoreError('UNSUPPORTED_SCHEMA', {
        diagnosticCode: mapped.diagnosticCode,
      });
    }
    return mapped;
  }

  private timestamp(): string {
    return toLedgerTimestamp(this.now());
  }

  private mintId(): string {
    const id = this.randomUUID();
    if (!LedgerUuidSchema.safeParse(id).success) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'invalid_uuid',
      });
    }
    return id;
  }

  private countRows(table: LedgerCountedTable): number {
    const row = this.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
    return row === undefined ? 0 : rowInteger(row, 'total');
  }

  private selectScope(ledgerId: string): LedgerScopeState | null {
    const row = this.prepare(LEDGER_SQL.selectScope).get(ledgerId);
    return row === undefined ? null : scopeFromRow(row);
  }

  private selectScopeByIdentity(
    identity: Pick<LedgerScopeIdentity, 'columns' | 'containerCreatedAt'>,
  ): LedgerScopeState | null {
    const row = this.prepare(LEDGER_SQL.selectScopeByContainer).get(
      identity.columns.kind,
      identity.columns.parentId,
      identity.columns.itemId,
      identity.containerCreatedAt,
    );
    return row === undefined ? null : scopeFromRow(row);
  }

  /**
   * The scope a global binding names. A binding that names anything but a
   * global container of its own owner is a storage fault.
   */
  private selectGlobalScope(
    key: LedgerGlobalScopeKey,
  ): LedgerScopeState | null {
    const row = this.prepare(LEDGER_SQL.selectGlobalScope).get(
      key.ownerKey,
      key.accountKey,
    );
    if (row === undefined) return null;
    const scope = scopeFromRow(row);
    const container = scope.record.scope.container;
    if (
      !isLedgerGlobalContainer(container) ||
      ledgerGlobalOwnerKey(container.owner) !== key.ownerKey
    ) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'malformed_global_binding',
      });
    }
    return scope;
  }

  /**
   * A creation time no incarnation of the container has yet: now, or the
   * first millisecond after it that is free when the clock repeated or went
   * back.
   */
  private mintIncarnation(columns: LedgerScopeIdentity['columns']): string {
    let instantMs = this.now().getTime();
    let containerCreatedAt = toLedgerTimestamp(new Date(instantMs));
    while (
      this.selectScopeByIdentity({ columns, containerCreatedAt }) !== null
    ) {
      instantMs += 1;
      containerCreatedAt = toLedgerTimestamp(new Date(instantMs));
    }
    return containerCreatedAt;
  }

  private requireScope(ledgerId: string): LedgerScopeState {
    const scope = this.selectScope(ledgerId);
    if (scope === null) {
      throw new LedgerStoreError('NOT_FOUND', { field: 'ledgerId' });
    }
    return scope;
  }

  private requireWritableScope(ledgerId: string): LedgerScopeState {
    const scope = this.requireScope(ledgerId);
    assertScopeWritable(scope);
    return scope;
  }

  /** Assigns the scope's next sequence number to the event being written. */
  private advanceSequence(ledgerId: string): number {
    const row = this.prepare(LEDGER_SQL.advanceSequence).get(ledgerId);
    if (row === undefined) {
      throw new LedgerStoreError('NOT_FOUND', { field: 'ledgerId' });
    }
    return rowInteger(row, 'sequence');
  }

  private appendOutbox(event: LedgerOutboxEvent): void {
    const payloadJson = toCanonicalJson(event.payload);
    this.prepare(LEDGER_SQL.insertOutbox).run(
      this.mintId(),
      event.ledgerId,
      event.sequence,
      event.kind,
      event.entryId,
      event.entryRevision,
      event.occurredAt,
      payloadJson,
      sha256Hex(payloadJson),
    );
  }

  private insertScope(binding: LedgerScopeBinding): LedgerScopeRecord {
    const ledgerId = this.mintId();
    const createdAt = this.timestamp();
    this.prepare(LEDGER_SQL.insertScope).run(
      ledgerId,
      binding.authorityId,
      binding.columns.kind,
      binding.columns.parentId,
      binding.columns.itemId,
      binding.containerCreatedAt,
      binding.accountId,
      createdAt,
    );
    const sequence = this.advanceSequence(ledgerId);
    this.appendOutbox({
      ledgerId,
      sequence,
      kind: 'scope_registered',
      entryId: null,
      entryRevision: null,
      occurredAt: createdAt,
      payload: {
        scope: {
          ledgerId,
          authorityId: binding.authorityId,
          container: binding.container,
        },
        containerCreatedAt: binding.containerCreatedAt,
        accountId: binding.accountId,
      },
    });
    return this.requireScope(ledgerId).record;
  }

  /**
   * Numbers a lifecycle move that was just written as the scope's next event,
   * when the move is replicated, and returns the scope as it now stands. The
   * event names where the scope lives, so a restore also carries a rebind.
   */
  private recordScopeLifecycleEvent(
    ledgerId: string,
    state: LedgerScopeLifecycleState,
  ): LedgerScopeRecord {
    const kind = SCOPE_LIFECYCLE_EVENT_KIND[state];
    if (kind === null) return this.requireScope(ledgerId).record;
    const sequence = this.advanceSequence(ledgerId);
    const scope = this.requireScope(ledgerId).record;
    this.appendOutbox({
      ledgerId,
      sequence,
      kind,
      entryId: null,
      entryRevision: null,
      occurredAt: this.timestamp(),
      payload: {
        scope: scope.scope,
        containerCreatedAt: scope.containerCreatedAt,
      },
    });
    return scope;
  }

  private selectActorByOriginKey(
    ledgerId: string,
    originKey: string,
  ): LedgerActorRecord | null {
    const row = this.prepare(LEDGER_SQL.selectActorByOriginKey).get(
      ledgerId,
      originKey,
    );
    return row === undefined ? null : actorFromRow(row);
  }

  private selectActorById(
    ledgerId: string,
    actorId: string,
  ): LedgerActorRecord | null {
    const row = this.prepare(LEDGER_SQL.selectActorById).get(ledgerId, actorId);
    return row === undefined ? null : actorFromRow(row);
  }

  private insertActor(
    ledgerId: string,
    registration: LedgerActorRegistration,
  ): LedgerActorRecord {
    const actor: LedgerActorRef = {
      actorId: this.mintId(),
      kind: registration.kind,
      authorityId: registration.authorityId,
    };
    const createdAt = this.timestamp();
    this.prepare(LEDGER_SQL.insertActor).run(
      actor.actorId,
      ledgerId,
      actor.kind,
      actor.authorityId,
      registration.originKey,
      registration.displayName,
      createdAt,
    );
    const sequence = this.advanceSequence(ledgerId);
    this.appendOutbox({
      ledgerId,
      sequence,
      kind: 'actor_registered',
      entryId: null,
      entryRevision: null,
      occurredAt: createdAt,
      payload: {
        actor,
        originKey: registration.originKey,
        displayName: registration.displayName,
      },
    });
    return {
      actor,
      ledgerId,
      originKey: registration.originKey,
      displayName: registration.displayName,
      createdAt,
    };
  }

  /**
   * A registered actor must match the reference exactly (ID, kind and
   * authority) and belong to this ledger.
   */
  private requireActor(
    ledgerId: string,
    actor: LedgerActorRef,
    reason: 'FORBIDDEN' | 'OWNER_UNAVAILABLE',
    field: string,
  ): void {
    const row = this.prepare(LEDGER_SQL.selectActorIdentity).get(
      ledgerId,
      actor.actorId,
    );
    if (
      row === undefined ||
      rowText(row, 'kind') !== actor.kind ||
      rowText(row, 'authority_id') !== actor.authorityId
    ) {
      throw new LedgerStoreError(reason, { field });
    }
  }

  /**
   * A new owner must be the host's eligible choice, may not be a sidecar, and
   * must be registered in this ledger.
   */
  private requireEligibleOwner(
    ledgerId: string,
    owner: LedgerActorRef,
    hostEligible: boolean,
  ): void {
    if (!hostEligible || !canLedgerActorOwn(owner.kind)) {
      throw new LedgerStoreError('OWNER_UNAVAILABLE', { field: 'owner' });
    }
    this.requireActor(ledgerId, owner, 'OWNER_UNAVAILABLE', 'owner');
  }

  /**
   * Receipt-first idempotency: a stored receipt for the same normalized
   * request is returned exactly; a different request under the same key
   * fails `IDEMPOTENCY_KEY_REUSED`.
   */
  private findReplay(
    key: LedgerReceiptKey,
    requestHash: string,
  ): LedgerCommandReceipt | null {
    const row = this.prepare(LEDGER_SQL.selectReceipt).get(
      key.ledgerId,
      key.actorId,
      key.operation,
      key.idempotencyKey,
    );
    if (row === undefined) return null;
    if (rowText(row, 'request_hash') !== requestHash) {
      throw new LedgerStoreError('IDEMPOTENCY_KEY_REUSED', {
        field: 'idempotencyKey',
      });
    }
    const receipt = parseStoredRecord(
      LedgerCommandReceiptSchema,
      rowText(row, 'response_json'),
    );
    // Everything a replay returns is what was stored, except how far sync
    // has come since: that is reported as it stands now, for the revision
    // the receipt returned. A change that changed nothing wrote no revision
    // of its own, so its local sequence is not that revision's.
    const scope = this.selectScope(key.ledgerId);
    const sequence = receipt.changed
      ? parseScopeSequence(receipt.localSequence)
      : this.versionSequence(
          key.ledgerId,
          receipt.entry.entryId,
          receipt.entry.revision,
        );
    return scope === null || sequence === null
      ? receipt
      : { ...receipt, syncState: this.syncStateAt(scope, sequence) };
  }

  /** The scope sequence a revision of an entry was committed at. */
  private versionSequence(
    ledgerId: string,
    entryId: string,
    revision: number,
  ): number | null {
    const row = this.prepare(LEDGER_SQL.selectVersionSequence).get(
      ledgerId,
      entryId,
      revision,
    );
    return row === undefined ? null : rowInteger(row, 'scope_sequence');
  }

  private selectScopeSync(ledgerId: string): LedgerStoredScopeSync {
    const row = this.prepare(LEDGER_SQL.selectScopeSync).get(ledgerId);
    return row === undefined ? LEDGER_UNSYNCED_SCOPE : scopeSyncFromRow(row);
  }

  private selectPendingTitle(entryId: string): LedgerPendingTitleRecord | null {
    const row = this.prepare(LEDGER_SQL.selectPendingTitle).get(entryId);
    return row === undefined ? null : pendingTitleFromRow(row);
  }

  private scopeSyncRecord(scope: LedgerScopeState): LedgerScopeSyncRecord {
    return toScopeSyncRecord(
      this.requireScope(scope.ledgerId).record,
      this.selectScopeSync(scope.ledgerId),
    );
  }

  /** Where the revision committed at `sequence` stands; see `sync.ts`. */
  private syncStateAt(
    scope: LedgerScopeState,
    sequence: number,
  ): LedgerSyncState {
    return ledgerSyncStateAt(
      scope.record.accountId,
      sequence,
      this.selectScopeSync(scope.ledgerId),
    );
  }

  /**
   * Stores a receipt and returns it exactly as a replay will: both are parsed
   * from the same stored JSON.
   */
  private insertReceipt(
    key: LedgerReceiptKey,
    requestHash: string,
    receipt: LedgerCommandReceipt,
  ): LedgerCommandReceipt {
    const responseJson = toCanonicalJson(receipt);
    this.prepare(LEDGER_SQL.insertReceipt).run(
      key.ledgerId,
      key.actorId,
      key.operation,
      key.idempotencyKey,
      requestHash,
      receipt.entry.entryId,
      receipt.mutationId,
      responseJson,
      this.timestamp(),
    );
    return parseStoredRecord(LedgerCommandReceiptSchema, responseJson);
  }

  /** The entry's current projection, under its scope's current identity. */
  private requireEntry(
    scope: LedgerScopeState,
    entryId: string,
  ): LedgerCurrentEntry {
    const row = this.prepare(LEDGER_SQL.selectEntry).get(
      scope.ledgerId,
      entryId,
    );
    if (row === undefined) {
      throw new LedgerStoreError('NOT_FOUND', { field: 'entryId' });
    }
    return {
      entryRowid: rowInteger(row, 'entry_rowid'),
      sequence: rowInteger(row, 'scope_sequence'),
      entry: withCurrentScope(
        parseStoredEntry(rowText(row, 'projection_json')),
        scope,
      ),
    };
  }

  private isEntryTitleAcknowledged(ledgerId: string, entryId: string): boolean {
    const firstVersion = this.prepare(LEDGER_SQL.selectEntryFirstSequence).get(
      ledgerId,
      entryId,
    );
    if (
      firstVersion === undefined ||
      firstVersion.scope_sequence === null ||
      firstVersion.scope_sequence === undefined
    ) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'pending_title_versions',
      });
    }
    const firstSequence = rowInteger(firstVersion, 'scope_sequence');
    return this.selectScopeSync(ledgerId).acknowledged >= firstSequence;
  }

  private rewritePendingTitle(
    scope: LedgerScopeState,
    current: LedgerCurrentEntry,
    title: string,
  ): LedgerEntry {
    const currentRow = this.prepare(LEDGER_SQL.selectEntry).get(
      scope.ledgerId,
      current.entry.entryId,
    );
    if (currentRow === undefined) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'pending_title_entry',
      });
    }
    const storedCurrent = parseStoredEntry(
      rowText(currentRow, 'projection_json'),
    );
    const updatedCurrent = parseLedgerInput(
      LedgerEntrySchema,
      { ...storedCurrent, title },
      '',
    );
    this.prepare(LEDGER_SQL.updateEntryProjection).run(
      toCanonicalJson(updatedCurrent),
      current.entryRowid,
    );

    const versions = this.prepare(LEDGER_SQL.selectEntryVersionProjections).all(
      scope.ledgerId,
      current.entry.entryId,
    );
    if (versions.length === 0) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'pending_title_versions',
      });
    }
    for (const version of versions) {
      const storedVersion = parseStoredEntry(
        rowText(version, 'projection_json'),
      );
      if (storedVersion.entryId !== current.entry.entryId) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'pending_title_version_entry',
        });
      }
      const updatedVersion = parseLedgerInput(
        LedgerEntrySchema,
        { ...storedVersion, title },
        '',
      );
      this.prepare(LEDGER_SQL.updateEntryVersionProjection).run(
        toCanonicalJson(updatedVersion),
        rowInteger(version, 'version_rowid'),
      );
    }

    this.prepare(LEDGER_SQL.updateSearchTitle).run(title, current.entryRowid);

    const outboxRows = this.prepare(LEDGER_SQL.selectEntryOutboxPayloads).all(
      scope.ledgerId,
      current.entry.entryId,
    );
    for (const outboxRow of outboxRows) {
      const payload = parseStoredRecord(
        LedgerEntryOutboxPayloadSchema,
        rowText(outboxRow, 'payload_json'),
      );
      if (payload.entry.entryId !== current.entry.entryId) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'pending_title_outbox_entry',
        });
      }
      const updatedOutboxEntry = parseLedgerInput(
        LedgerEntrySchema,
        { ...payload.entry, title },
        '',
      );
      const rewrittenPayload = { ...payload, entry: updatedOutboxEntry };
      const payloadJson = toCanonicalJson(rewrittenPayload);
      this.prepare(LEDGER_SQL.updateOutboxPayload).run(
        payloadJson,
        sha256Hex(payloadJson),
        rowInteger(outboxRow, 'outbox_rowid'),
      );
    }

    return withCurrentScope(updatedCurrent, scope);
  }

  private createEntry(
    ledgerId: string,
    request: LedgerCreateRequest,
  ): LedgerStoreCommandReceipt {
    const replay = this.findReplay(request.receiptKey, request.requestHash);
    if (replay !== null) return replay;
    const scope = this.requireWritableScope(ledgerId);
    this.assertCreationAllowed(scope, request.draft);
    const parentEntryId = this.resolveCreationParent(scope, request);
    const receipt = this.insertNewEntry(scope, request, parentEntryId);
    const started =
      receipt.entry.status === 'IN_PROGRESS'
        ? this.autoStartOperation(scope, receipt.entry, request)
        : null;
    return withRelatedChanges(receipt, started === null ? [] : [started]);
  }

  private assertCreationAllowed(
    scope: LedgerScopeState,
    draft: LedgerEntryDraft,
  ): void {
    throwIfViolation(checkLedgerCreation(draft));
    // A global Ledger has no worktree for a file to be relative to.
    if (
      isLedgerGlobalContainer(scope.record.scope.container) &&
      draft.referenceFiles.length > 0
    ) {
      throw new LedgerStoreError('INVALID_INPUT', { field: 'referenceFiles' });
    }
    if (draft.origin.ledgerId !== scope.ledgerId) {
      throw new LedgerStoreError('INVALID_INPUT', { field: 'origin.ledgerId' });
    }
    this.requireActor(scope.ledgerId, draft.author, 'FORBIDDEN', 'author');
    this.requireActor(
      scope.ledgerId,
      draft.attribution.recordedBy,
      'FORBIDDEN',
      'attribution.recordedBy',
    );
    // Owning one's own new entry is always allowed; only an explicit other
    // owner is subject to the host's eligibility verdict.
    this.requireEligibleOwner(
      scope.ledgerId,
      draft.owner,
      draft.ownerEligible || draft.owner.actorId === draft.author.actorId,
    );
    if (
      draft.supersedesEntryId !== undefined &&
      this.prepare(LEDGER_SQL.selectEntry).get(
        scope.ledgerId,
        draft.supersedesEntryId,
      ) === undefined
    ) {
      // Entries in other ledgers are indistinguishable from missing ones.
      throw new LedgerStoreError('INVALID_INPUT', {
        field: 'supersedesEntryId',
      });
    }
  }

  /**
   * Corrections inherit their target's parent; a caller cannot redirect one.
   * Corrections are the only way to amend a closed entry, so an inherited
   * parent may be closed; it must still exist and be of a valid type.
   */
  private resolveCreationParent(
    scope: LedgerScopeState,
    request: LedgerCreateRequest,
  ): string | undefined {
    const supersedesEntryId = request.draft.supersedesEntryId;
    if (supersedesEntryId === undefined) {
      if (request.parentEntryId !== undefined) {
        this.assertValidParent(
          scope,
          request.draft.type,
          request.parentEntryId,
        );
      }
      return request.parentEntryId;
    }
    const corrected = this.requireEntry(scope, supersedesEntryId).entry;
    if (
      request.parentEntryId !== undefined &&
      request.parentEntryId !== corrected.parentEntryId
    ) {
      throw new LedgerStoreError('PARENT_INVALID', {
        field: 'parentEntryId',
      });
    }
    const parentEntryId = corrected.parentEntryId;
    if (parentEntryId !== undefined) {
      this.assertValidParent(
        scope,
        request.draft.type,
        parentEntryId,
        undefined,
        { allowClosedParent: true },
      );
    }
    return parentEntryId;
  }

  /**
   * Enforces parent types and the two-level task chain, and that the parent
   * is open unless `allowClosedParent` (an inherited correction parent).
   */
  private assertValidParent(
    scope: LedgerScopeState,
    childType: LedgerEntry['type'],
    parentEntryId: string | null,
    movingEntryId?: string,
    options: { readonly allowClosedParent?: boolean } = {},
  ): void {
    if (parentEntryId === null) return;
    if (childType === 'OPERATION' || childType === 'SUMMARY') {
      throw new LedgerStoreError('PARENT_INVALID', {
        field: 'parentEntryId',
      });
    }
    if (
      this.prepare(LEDGER_SQL.selectEntry).get(
        scope.ledgerId,
        parentEntryId,
      ) === undefined
    ) {
      throw new LedgerStoreError('PARENT_INVALID', {
        field: 'parentEntryId',
      });
    }
    const parent = this.requireEntry(scope, parentEntryId).entry;
    if (
      options.allowClosedParent !== true &&
      !isLedgerEntryOpen(parent.status)
    ) {
      throw new LedgerStoreError('PARENT_CLOSED', {
        field: 'parentEntryId',
      });
    }
    if (parent.type !== 'OPERATION' && parent.type !== 'TASK') {
      throw new LedgerStoreError('PARENT_INVALID', {
        field: 'parentEntryId',
      });
    }

    if (movingEntryId !== undefined) {
      const subtree = this.prepare(LEDGER_SQL.selectSubtreeRowIds).all(
        scope.ledgerId,
        movingEntryId,
        scope.ledgerId,
      );
      if (subtree.some((row) => rowText(row, 'entry_id') === parentEntryId)) {
        throw new LedgerStoreError('PARENT_INVALID', {
          field: 'parentEntryId',
        });
      }
    }

    if (childType === 'TASK') {
      const parentTaskDepth = this.taskAncestorDepth(scope, parent.entryId);
      const movedTaskDepth =
        movingEntryId === undefined
          ? 0
          : this.maxTaskDescendantDepth(scope, movingEntryId);
      if (parentTaskDepth + 1 + movedTaskDepth > 2) {
        throw new LedgerStoreError('PARENT_INVALID', {
          field: 'parentEntryId',
        });
      }
    }
  }

  /** Counts only TASK ancestors; OPERATION is a boundary, not a task level. */
  private taskAncestorDepth(scope: LedgerScopeState, entryId: string): number {
    let depth = 0;
    let current = this.requireEntry(scope, entryId).entry;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(current.entryId)) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'ledger_parent_cycle',
        });
      }
      visited.add(current.entryId);
      if (current.type === 'OPERATION') return depth;
      if (current.type !== 'TASK') {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'ledger_parent_type',
        });
      }
      depth += 1;
      if (depth > 2) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'ledger_task_depth',
        });
      }
      if (current.parentEntryId === undefined) return depth;
      current = this.requireEntry(scope, current.parentEntryId).entry;
    }
  }

  /** Maximum number of TASK descendants beneath a task being moved. */
  private maxTaskDescendantDepth(
    scope: LedgerScopeState,
    entryId: string,
  ): number {
    const row = this.prepare(LEDGER_SQL.selectTaskSubtreeDepth).get(
      scope.ledgerId,
      entryId,
      scope.ledgerId,
    );
    if (row === undefined) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'task_subtree_missing',
      });
    }
    return rowInteger(row, 'depth');
  }

  private insertNewEntry(
    scope: LedgerScopeState,
    request: LedgerCreateRequest,
    parentEntryId: string | undefined,
  ): LedgerCommandReceipt {
    const entryId = this.mintId();
    const createdAt = this.timestamp();
    const sequence = this.advanceSequence(scope.ledgerId);
    // Validating the complete projection is the last guard: nothing that
    // violates the protocol entry schema is ever persisted.
    const entry = parseLedgerInput(
      LedgerEntrySchema,
      buildNewEntry(scope, request.draft, entryId, createdAt, parentEntryId),
      '',
    );
    const mutation = parseLedgerInput(
      LedgerMutationSchema,
      {
        mutationId: this.mintId(),
        entryId,
        kind: 'create',
        revision: 1,
        previousRevision: null,
        occurredAt: createdAt,
        status: { from: null, to: entry.status },
        owner: { from: null, to: entry.owner },
        attribution: entry.attribution,
        invocationOrigin: entry.origin,
      },
      '',
    );
    const inserted = this.prepare(LEDGER_SQL.insertEntry).get(
      entry.entryId,
      entry.scope.ledgerId,
      entry.revision,
      sequence,
      entry.type,
      entry.status,
      entry.author.actorId,
      entry.owner.actorId,
      entry.attribution.kind,
      entry.createdAt,
      entry.updatedAt,
      entry.supersedesEntryId ?? null,
      entry.parentEntryId ?? null,
      toCanonicalJson(entry),
    );
    if (inserted === undefined) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'entry_insert',
      });
    }
    const entryRowid = rowInteger(inserted, 'entry_rowid');
    const rootEntryId =
      parentEntryId === undefined
        ? entry.entryId
        : this.currentRootForEntry(scope, parentEntryId);
    this.prepare(LEDGER_SQL.insertRoot).run(
      entryRowid,
      scope.ledgerId,
      rootEntryId,
      sequence,
    );
    this.prepare(LEDGER_SQL.insertSearch).run(
      entryRowid,
      entry.title,
      entry.content,
      entry.highlights.join('\n'),
    );
    if (request.draft.path === 'add' && request.draft.pendingTitle) {
      this.prepare(LEDGER_SQL.insertPendingTitle).run(
        entry.entryId,
        entry.createdAt,
      );
    }
    return this.recordRevision({
      accountId: scope.record.accountId,
      entryRowid,
      entry,
      mutation,
      sequence,
      receiptKey: request.receiptKey,
      requestHash: request.requestHash,
      publication: request.draft.publication,
    });
  }

  private assertUpdateCaller(
    scope: LedgerScopeState,
    request: LedgerUpdateRequest,
  ): void {
    throwIfViolation(checkLedgerAttribution(request.attribution));
    if (request.invocationOrigin.ledgerId !== scope.ledgerId) {
      throw new LedgerStoreError('INVALID_INPUT', {
        field: 'invocationOrigin.ledgerId',
      });
    }
    this.requireActor(
      scope.ledgerId,
      request.attribution.effectiveActor,
      'FORBIDDEN',
      'attribution.effectiveActor',
    );
    this.requireActor(
      scope.ledgerId,
      request.attribution.recordedBy,
      'FORBIDDEN',
      'attribution.recordedBy',
    );
  }

  private prepareChildClose(
    scope: LedgerScopeState,
    current: LedgerCurrentEntry,
    request: LedgerUpdateRequest,
    targetStatus: LedgerStatus | undefined,
  ): LedgerChildClosePlan | null {
    if (targetStatus === undefined || isLedgerEntryOpen(targetStatus)) {
      return null;
    }
    // Open entries can sit beneath children that are already closed (a
    // person's close leaves its children open), so look at every depth.
    const nearestOpen = this.selectNearestOpenDescendants(
      scope,
      current.entry.entryId,
    );
    if (nearestOpen.length === 0) return null;

    const choice = request.params.openChildren;
    if (choice === undefined) {
      if (request.mayUpdateAnyOpenEntry) return null;
      throw new LedgerStoreError('OPEN_CHILDREN', {
        openChildEntryIds: nearestOpen.map((child) => child.entry.entryId),
      });
    }

    // Detach moves the same nearest open entries the refusal names, so an open
    // subtask under an already-closed task goes to top level with its subtree.
    const openDescendants =
      choice === 'detach'
        ? nearestOpen
        : this.selectOpenDescendantsPostOrder(scope, current.entry.entryId);
    const unauthorizedChildren = openDescendants.filter(
      (child) =>
        !canLedgerActorUpdateOwnedEntry(
          request.attribution,
          child.entry.owner.actorId,
          request.delegateOwnerActorIds,
        ),
    );
    if (!request.mayUpdateAnyOpenEntry && unauthorizedChildren.length > 0) {
      throw new LedgerStoreError('OPEN_CHILDREN', {
        openChildEntryIds: unauthorizedChildren.map(
          (child) => child.entry.entryId,
        ),
      });
    }
    return {
      choice,
      detachTargets: nearestOpen,
      openDescendants,
    };
  }

  /** Applies the plan and returns each revised child, in commit order. */
  private applyChildClose(
    scope: LedgerScopeState,
    request: LedgerUpdateRequest,
    plan: LedgerChildClosePlan,
  ): LedgerEntry[] {
    if (plan.choice === 'detach') {
      return plan.detachTargets.map(
        (child): LedgerEntry =>
          this.applyInternalMutation(
            scope,
            child,
            request,
            {
              status: null,
              owner: null,
              parent: {
                from: child.entry.parentEntryId ?? null,
                to: null,
              },
            },
            'cascade-detach',
          ),
      );
    }

    const status: LedgerStatus =
      plan.choice === 'complete' ? 'COMPLETED' : 'FAILED';
    return plan.openDescendants.map(
      (child): LedgerEntry =>
        this.applyInternalMutation(
          scope,
          child,
          request,
          {
            status: { from: child.entry.status, to: status },
            owner: null,
            parent: null,
          },
          'cascade-close',
        ),
    );
  }

  private selectChildren(
    scope: LedgerScopeState,
    parentEntryId: string,
  ): LedgerCurrentEntry[] {
    return this.prepare(LEDGER_SQL.selectChildren)
      .all(scope.ledgerId, parentEntryId)
      .map(
        (row): LedgerCurrentEntry => ({
          entryRowid: rowInteger(row, 'entry_rowid'),
          sequence: rowInteger(row, 'scope_sequence'),
          entry: withCurrentScope(
            parseStoredEntry(rowText(row, 'projection_json')),
            scope,
          ),
        }),
      );
  }

  /**
   * The open descendants reached through closed entries only: each open
   * direct child, and each open entry whose ancestors up to `parentEntryId`
   * are all closed. Empty exactly when no descendant is open.
   */
  private selectNearestOpenDescendants(
    scope: LedgerScopeState,
    parentEntryId: string,
  ): LedgerCurrentEntry[] {
    const openEntries: LedgerCurrentEntry[] = [];
    const visited = new Set<string>([parentEntryId]);
    const visit = (entryId: string): void => {
      for (const child of this.selectChildren(scope, entryId)) {
        if (visited.has(child.entry.entryId)) {
          throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
            diagnosticCode: 'ledger_parent_cycle',
          });
        }
        visited.add(child.entry.entryId);
        if (isLedgerEntryOpen(child.entry.status)) {
          openEntries.push(child);
        } else {
          visit(child.entry.entryId);
        }
      }
    };
    visit(parentEntryId);
    return openEntries;
  }

  private selectOpenDescendantsPostOrder(
    scope: LedgerScopeState,
    parentEntryId: string,
  ): LedgerCurrentEntry[] {
    const openEntries: LedgerCurrentEntry[] = [];
    const visited = new Set<string>([parentEntryId]);
    const visit = (entryId: string): void => {
      for (const child of this.selectChildren(scope, entryId)) {
        if (visited.has(child.entry.entryId)) {
          throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
            diagnosticCode: 'ledger_parent_cycle',
          });
        }
        visited.add(child.entry.entryId);
        visit(child.entry.entryId);
        if (isLedgerEntryOpen(child.entry.status)) openEntries.push(child);
      }
    };
    visit(parentEntryId);
    return openEntries;
  }

  private applyInternalMutation(
    scope: LedgerScopeState,
    current: LedgerCurrentEntry,
    request: LedgerUpdateRequest,
    change: LedgerEntryChange,
    purpose: string,
  ): LedgerEntry {
    const context: LedgerMutationContext = {
      attribution: request.attribution,
      invocationOrigin: request.invocationOrigin,
      ownerEligible: true,
      receiptKey: this.internalReceiptKey(
        scope,
        request.receiptKey,
        purpose,
        current.entry.entryId,
      ),
      requestHash: hashLedgerCanonicalValue({
        purpose,
        entryId: current.entry.entryId,
        revision: current.entry.revision,
        status: change.status?.to ?? null,
        parentEntryId: change.parent?.to ?? null,
      }),
    };
    return this.applyChange(scope, current, context, change).entry;
  }

  private internalReceiptKey(
    scope: LedgerScopeState,
    caller: LedgerReceiptKey,
    purpose: string,
    entryId: string,
  ): LedgerReceiptKey {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const key = `__ledger_internal__:${purpose}:${entryId}:${this.mintId()}:${attempt}`;
      if (
        this.prepare(LEDGER_SQL.selectReceipt).get(
          scope.ledgerId,
          caller.actorId,
          'core.ledger.entry.update',
          key,
        ) === undefined
      ) {
        return {
          ...caller,
          operation: 'core.ledger.entry.update',
          idempotencyKey: key,
        };
      }
    }
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'internal_receipt_collision',
    });
  }

  /** Starts the child's TODO operation, if any, and returns its revision. */
  private autoStartOperation(
    scope: LedgerScopeState,
    child: LedgerEntry,
    request: LedgerCreateRequest | LedgerUpdateRequest,
  ): LedgerEntry | null {
    let ancestor = child;
    const visited = new Set([child.entryId]);
    while (ancestor.parentEntryId !== undefined) {
      if (visited.has(ancestor.parentEntryId)) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'ledger_parent_cycle',
        });
      }
      visited.add(ancestor.parentEntryId);
      const current = this.requireEntry(scope, ancestor.parentEntryId);
      ancestor = current.entry;
      if (ancestor.type !== 'OPERATION' || ancestor.status !== 'TODO') continue;
      const attribution =
        'draft' in request ? request.draft.attribution : request.attribution;
      const origin =
        'draft' in request ? request.draft.origin : request.invocationOrigin;
      const baseReceiptKey = request.receiptKey;
      const systemAttribution: LedgerAttribution = {
        kind: 'system',
        effectiveActor: attribution.effectiveActor,
        recordedBy: attribution.recordedBy,
        executorDetails: attribution.executorDetails,
      };
      return this.applyChange(
        scope,
        current,
        {
          attribution: systemAttribution,
          invocationOrigin: origin,
          ownerEligible: true,
          receiptKey: this.internalReceiptKey(
            scope,
            baseReceiptKey,
            'auto-start',
            ancestor.entryId,
          ),
          requestHash: hashLedgerCanonicalValue({
            purpose: 'auto-start',
            entryId: ancestor.entryId,
            revision: ancestor.revision,
            status: 'IN_PROGRESS',
          }),
        },
        {
          status: { from: 'TODO', to: 'IN_PROGRESS' },
          owner: null,
          parent: null,
        },
      ).entry;
    }
    return null;
  }

  /** An open-entry no-op keeps revision and times, but its receipt persists. */
  private recordNoop(
    scope: LedgerScopeState,
    current: LedgerCurrentEntry,
    receiptKey: LedgerReceiptKey,
    requestHash: string,
  ): LedgerCommandReceipt {
    return this.insertReceipt(receiptKey, requestHash, {
      entry: current.entry,
      changed: false,
      mutationId: null,
      localSequence: scope.record.sequence,
      // Nothing was written: the state is that of the entry's own revision.
      syncState: this.syncStateAt(scope, current.sequence),
    });
  }

  private currentRootForEntry(
    scope: LedgerScopeState,
    entryId: string,
  ): string {
    const current = this.requireEntry(scope, entryId);
    const row = this.prepare(LEDGER_SQL.selectCurrentRoot).get(
      current.entryRowid,
    );
    if (row === undefined) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'entry_root_missing',
      });
    }
    return rowText(row, 'root_entry_id');
  }

  private moveSubtreeRoot(
    scope: LedgerScopeState,
    entryRowid: number,
    entryId: string,
    rootEntryId: string,
    sequence: number,
  ): void {
    const rows = this.prepare(LEDGER_SQL.selectSubtreeRowIds).all(
      scope.ledgerId,
      entryId,
      scope.ledgerId,
    );
    if (rows.length === 0) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'entry_subtree_missing',
      });
    }
    for (const row of rows) {
      const rowid = rowInteger(row, 'entry_rowid');
      const closed = this.prepare(LEDGER_SQL.closeCurrentRoot).run(
        sequence,
        rowid,
      );
      if (Number(closed.changes) !== 1) {
        throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
          diagnosticCode: 'entry_root_missing',
        });
      }
      this.prepare(LEDGER_SQL.insertRoot).run(
        rowid,
        scope.ledgerId,
        rootEntryId,
        sequence,
      );
    }
    if (!rows.some((row) => rowInteger(row, 'entry_rowid') === entryRowid)) {
      throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
        diagnosticCode: 'entry_subtree_root_missing',
      });
    }
  }

  private applyChange(
    scope: LedgerScopeState,
    current: LedgerCurrentEntry,
    request: LedgerMutationContext,
    change: LedgerEntryChange,
  ): LedgerCommandReceipt {
    if (change.owner !== null) {
      this.requireEligibleOwner(
        scope.ledgerId,
        change.owner.to,
        request.ownerEligible,
      );
    }
    const previous = current.entry;
    const sequence = this.advanceSequence(scope.ledgerId);
    const updatedAt = laterTimestamp(this.timestamp(), previous.updatedAt);
    const projection = {
      ...previous,
      revision: previous.revision + 1,
      updatedAt,
      status: change.status?.to ?? previous.status,
      owner: change.owner?.to ?? previous.owner,
    };
    if (change.parent !== null) {
      delete projection.parentEntryId;
      if (change.parent.to !== null) {
        projection.parentEntryId = change.parent.to;
      }
    }
    const entry = parseLedgerInput(LedgerEntrySchema, projection, '');
    const movedRootEntryId =
      change.parent === null
        ? null
        : change.parent.to === null
          ? entry.entryId
          : this.currentRootForEntry(scope, change.parent.to);
    const mutation = parseLedgerInput(
      LedgerMutationSchema,
      {
        mutationId: this.mintId(),
        entryId: entry.entryId,
        kind: 'update',
        revision: entry.revision,
        previousRevision: previous.revision,
        occurredAt: updatedAt,
        ...(change.status === null ? {} : { status: change.status }),
        ...(change.owner === null ? {} : { owner: change.owner }),
        ...(change.parent === null ? {} : { parent: change.parent }),
        ...(request.leftOpen === undefined
          ? {}
          : { leftOpen: request.leftOpen }),
        attribution: request.attribution,
        invocationOrigin: request.invocationOrigin,
      },
      '',
    );
    const updated = this.prepare(LEDGER_SQL.updateEntry).run(
      entry.revision,
      sequence,
      entry.status,
      entry.owner.actorId,
      entry.updatedAt,
      entry.parentEntryId ?? null,
      toCanonicalJson(entry),
      current.entryRowid,
      previous.revision,
    );
    if (Number(updated.changes) !== 1) {
      throw updateRejection('REVISION_CONFLICT', 'expectedRevision', previous);
    }
    if (movedRootEntryId !== null) {
      this.moveSubtreeRoot(
        scope,
        current.entryRowid,
        entry.entryId,
        movedRootEntryId,
        sequence,
      );
    }
    return this.recordRevision({
      accountId: scope.record.accountId,
      entryRowid: current.entryRowid,
      entry,
      mutation,
      sequence,
      receiptKey: request.receiptKey,
      requestHash: request.requestHash,
      publication: null,
    });
  }

  /**
   * Writes the immutable version, the mutation, the receipt and the outbox
   * event for a revision that the caller already applied to the entry row.
   */
  private recordRevision(write: LedgerRevisionWrite): LedgerCommandReceipt {
    const { entry, mutation, sequence } = write;
    const ledgerId = entry.scope.ledgerId;
    this.prepare(LEDGER_SQL.insertVersion).run(
      write.entryRowid,
      entry.entryId,
      ledgerId,
      entry.revision,
      sequence,
      mutation.mutationId,
      entry.type,
      entry.status,
      entry.author.actorId,
      entry.owner.actorId,
      entry.attribution.kind,
      entry.createdAt,
      entry.updatedAt,
      entry.parentEntryId ?? null,
      toCanonicalJson(entry),
    );
    this.prepare(LEDGER_SQL.insertMutation).run(
      mutation.mutationId,
      write.entryRowid,
      ledgerId,
      mutation.kind,
      mutation.revision,
      mutation.previousRevision,
      sequence,
      mutation.attribution.effectiveActor.actorId,
      mutation.attribution.recordedBy.actorId,
      mutation.occurredAt,
      toCanonicalJson(mutation),
    );
    const receipt = this.insertReceipt(write.receiptKey, write.requestHash, {
      entry,
      changed: true,
      mutationId: mutation.mutationId,
      localSequence: String(sequence),
      syncState: ledgerSyncStateAt(
        write.accountId,
        sequence,
        this.selectScopeSync(ledgerId),
      ),
    });
    this.appendOutbox({
      ledgerId,
      sequence,
      kind: 'entry_revision',
      entryId: entry.entryId,
      entryRevision: entry.revision,
      occurredAt: mutation.occurredAt,
      payload: {
        entry,
        mutation,
        ...(write.publication === null
          ? {}
          : { publication: write.publication }),
      },
    });
    return receipt;
  }

  private cursorBase(
    ledgerId: string,
  ): Pick<LedgerCursorState, 'ledgerId' | 'schemaVersion' | 'issuedAtMs'> {
    return {
      ledgerId,
      schemaVersion: this.schema.version,
      issuedAtMs: this.now().getTime(),
    };
  }

  /** Cursors bind the ledger and schema version and live ten minutes. */
  private isCursorCurrent(state: LedgerCursorState, ledgerId: string): boolean {
    return (
      state.ledgerId === ledgerId &&
      state.schemaVersion === this.schema.version &&
      isLedgerCursorFresh(state.issuedAtMs, this.now().getTime())
    );
  }

  private readHistory(
    input: LedgerGetEntryInput,
    current: LedgerCurrentEntry,
  ): LedgerHistoryPage {
    const limit = pageLimit(
      input.historyLimit,
      LEDGER_LIMITS.historyPageDefault,
      LEDGER_LIMITS.historyPageMax,
      'historyLimit',
    );
    const afterRevision =
      input.historyCursor === undefined
        ? 0
        : this.resolveHistoryCursor(input.historyCursor, current.entry);
    const rows = this.prepare(LEDGER_SQL.selectHistory).all(
      current.entryRowid,
      afterRevision,
      limit + 1,
    );
    const mutations = rows
      .slice(0, limit)
      .map((row) =>
        parseStoredRecord(LedgerMutationSchema, rowText(row, 'mutation_json')),
      );
    const last = mutations[mutations.length - 1];
    return {
      mutations,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeLedgerCursor(
              {
                kind: 'history',
                ...this.cursorBase(current.entry.scope.ledgerId),
                entryId: current.entry.entryId,
                afterRevision: last.revision,
              },
              this.cursorSecret,
            )
          : null,
    };
  }

  private resolveHistoryCursor(cursor: string, entry: LedgerEntry): number {
    const state = decodeLedgerCursor(cursor, this.cursorSecret);
    if (
      state === null ||
      state.kind !== 'history' ||
      state.entryId !== entry.entryId ||
      !this.isCursorCurrent(state, entry.scope.ledgerId)
    ) {
      throw cursorExpired('historyCursor');
    }
    return state.afterRevision;
  }

  private resolveSearchCursor(
    cursor: string,
    scope: LedgerScopeState,
    search: LedgerNormalizedSearch,
  ): LedgerSearchPagePosition {
    const state = decodeLedgerCursor(cursor, this.cursorSecret);
    if (
      state === null ||
      state.kind !== 'search' ||
      state.filterHash !== search.filterHash ||
      state.sort !== search.sort ||
      !this.isCursorCurrent(state, scope.ledgerId)
    ) {
      throw cursorExpired('cursor');
    }
    const watermark = parseScopeSequence(state.watermark);
    if (watermark === null || watermark > scope.sequence) {
      throw cursorExpired('cursor');
    }
    return {
      watermark,
      after: { sortValue: state.lastSortValue, entryId: state.lastEntryId },
    };
  }

  /**
   * Reads up to `limit + 1` snapshot rows so `hasMore` needs no count. Each is
   * reported under the scope's current identity, as the source resolver sees
   * it.
   */
  private readSearchPage(
    scope: LedgerScopeState,
    search: LedgerNormalizedSearch,
    position: LedgerSearchPagePosition,
  ): LedgerSearchRow[] {
    if (search.words !== null && search.words.length === 0) return [];
    const statement = buildLedgerSearchPageStatement(
      scope.ledgerId,
      search,
      position,
      search.limit + 1,
      scope.sequence,
    );
    return this.requireDatabase()
      .prepare(statement.sql)
      .all(...statement.params)
      .map(
        (row): LedgerSearchRow => ({
          entry: withCurrentScope(
            parseStoredEntry(rowText(row, 'projection_json')),
            scope,
          ),
          sequence: rowInteger(row, 'scope_sequence'),
          leftOpen: rowLeftOpen(row),
        }),
      );
  }

  private searchCursor(
    ledgerId: string,
    search: LedgerNormalizedSearch,
    position: LedgerSearchPagePosition,
    last: LedgerEntry,
  ): string {
    return encodeLedgerCursor(
      {
        kind: 'search',
        ...this.cursorBase(ledgerId),
        watermark: String(position.watermark),
        sort: search.sort,
        filterHash: search.filterHash,
        lastSortValue:
          search.sort === 'updated_desc' ? last.updatedAt : last.createdAt,
        lastEntryId: last.entryId,
      },
      this.cursorSecret,
    );
  }
}
