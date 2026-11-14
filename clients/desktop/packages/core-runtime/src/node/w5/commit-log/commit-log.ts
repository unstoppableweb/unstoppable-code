import { readW5BackupPosition } from './backup-position';
import { basename, dirname } from 'node:path';
import type { W5FileConflict } from './apply';
import {
  W5_CAPTURE_LIMITS,
  W5_CAPTURE_KEY_MAX,
  type W5CaptureEvidence,
  type W5CaptureFile,
  type W5FileChainEvidence,
  type W5FileLogEvidence,
} from './capture-contract';
import type { DatabaseSync } from 'node:sqlite';

import {
  KEYED_RECEIPT_RETRY_WINDOW_MS,
  type KeyedReceiptKey,
} from '../../../kernel/keyed-receipt';
import {
  isCleanConflictEvidence,
  isTransientUnwrittenFailureEvidence,
} from './apply-evidence';
import { openW5CommitLogDatabase } from './database';
import { W5CommitLogError, W5CommitRefusedError } from './errors';
import { fingerprintW5File } from './fingerprint';
import {
  workspaceCreationDiagnosticsSchema,
  W5_RESERVATION_DIAGNOSTICS_MAX_BYTES,
  type WorkspaceCreationDiagnostics,
} from './reservation-diagnostics';

export { fingerprintW5File };

/**
 * A W5 resource with its own revision (CAN-3799 D4): the workspace
 * collection (membership and order), one workspace (index entry and
 * manifest), one workspace's worktree collection, and one worktree row.
 */
export type W5Resource =
  | { kind: 'workspaces' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'worktrees'; workspaceId: string }
  | { kind: 'worktree'; workspaceId: string; worktreeId: string };

export function w5ResourceKey(resource: W5Resource): string {
  switch (resource.kind) {
    case 'workspaces':
      return 'workspaces';
    case 'workspace':
      return `workspace:${resource.workspaceId}`;
    case 'worktrees':
      return `worktrees:${resource.workspaceId}`;
    case 'worktree':
      return `worktree:${resource.workspaceId}/${resource.worktreeId}`;
  }
}

/** Atomic read-only backup position, including revisions of deleted resources. */
export interface W5BackupPosition {
  readonly commitId: number;
  readonly schemaVersion: number;
  readonly revisions: Readonly<Record<string, number>>;
}

/** Who asked for a keyed change, and the request's identity. */
export type W5ReceiptKey = KeyedReceiptKey;

export interface W5FileChange {
  path: string;
  /** The new contents, or `null` to remove the file. */
  contents: string | null;
  /** {@link fingerprintW5File} of the contents this change replaces. */
  previousFingerprint: string | null;
}

export interface W5CommitRequest {
  operation: string;
  /** Present for a keyed request; binds the outcome to key and parameters. */
  receipt?: W5ReceiptKey & { fingerprint: string };
  /** Revisions the caller read; any that moved refuses the commit. */
  expectedRevisions?: ReadonlyArray<{ resource: W5Resource; revision: number }>;
  /** Resources whose revision this change advances. */
  advance: readonly W5Resource[];
  files: readonly W5FileChange[];
  /** The result a replay of this request returns. */
  outcome: unknown;
  /** The reservation this commit completes, if it ran uncertain effects. */
  reservationId?: string;
}

export type W5CommitResult =
  | {
      status: 'committed';
      commitId: number;
      /** The new revision of each advanced resource, by resource key. */
      revisions: Record<string, number>;
    }
  | { status: 'replayed'; commitId: number; outcome: unknown }
  /** Already completed; never rerun, even though its outcome has expired. */
  | { status: 'replay-expired'; commitId: number };

export type W5ReceiptLookup =
  | { status: 'none' }
  | { status: 'replay'; commitId: number; outcome: unknown }
  | { status: 'replay-expired'; commitId: number }
  /** The committed change never reached its files; it awaits recovery. */
  | {
      status: 'commit-recovery-required';
      commitId: number;
      diagnostics: unknown;
    }
  | { status: 'key-reused' }
  | { status: 'in-progress'; reservationId: string }
  | {
      status: 'recovery-required';
      reservationId: string;
      diagnostics: unknown;
    };

export interface W5PendingCommit {
  commitId: number;
  operation: string;
  files: W5FileChange[];
}

/** Content-free diagnostics for a failed live reservation. */
export interface W5ReservationFailureDiagnostics {
  operation: string;
  errorName: string;
  errorCode?: string;
}

export interface W5Reservation {
  reservationId: string;
  operation: string;
  state: 'reserved' | 'recovery-required';
  diagnostics: unknown;
}

/** Full outcomes survive for 30 days after completion (CAN-4029). */
export const W5_RECEIPT_RETRY_WINDOW_MS = KEYED_RECEIPT_RETRY_WINDOW_MS;
export const W5_COMPACTION_BATCH_SIZE = 100;
export const W5_COMPACTION_INTERVAL = 100;

export interface W5CommitLogOptions {
  openBusyTimeoutMs?: number;
  /** Milliseconds since the epoch. */
  clock?: () => number;
  retryWindowMs?: number;
}

function asInteger(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new W5CommitLogError('STORAGE_UNAVAILABLE', 'Unexpected column value.');
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new W5CommitLogError('STORAGE_UNAVAILABLE', 'Unexpected column value.');
}

function asNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}

function parseJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

/**
 * The W5 commit log (CAN-3805): the one durable commit decision for every W5
 * change. A commit records, in a single SQLite transaction, the new contents
 * of each JSON file the change writes, the revisions it advances and, for a
 * keyed request, its retry receipt. The JSON files are then brought up to
 * date by the applier, and a commit left unapplied by a crash is applied at
 * the next launch, so restart shows either the previous state with no new
 * outcome or the complete new state with its outcome.
 *
 * Synchronous: the host runs it on one connection, off the main event loop.
 */
export class W5CommitLog {
  private commitsSinceCompaction = 0;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => number,
    private readonly retryWindowMs: number,
  ) {}

  static open(
    databasePath: string,
    options?: W5CommitLogOptions | number,
  ): W5CommitLog {
    const settings =
      typeof options === 'number'
        ? { openBusyTimeoutMs: options }
        : (options ?? {});
    const clock = settings.clock ?? Date.now;
    const retryWindowMs = settings.retryWindowMs ?? W5_RECEIPT_RETRY_WINDOW_MS;
    if (!Number.isFinite(retryWindowMs) || retryWindowMs < 0) {
      throw new RangeError(
        'The W5 retry window must be finite and nonnegative.',
      );
    }
    return new W5CommitLog(
      openW5CommitLogDatabase(
        databasePath,
        settings.openBusyTimeoutMs,
        new Date(clock()).toISOString(),
      ),
      clock,
      retryWindowMs,
    );
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** The current revision of a resource; 0 when it has none yet. */
  revision(resource: W5Resource): number {
    const row = this.db
      .prepare('SELECT revision FROM w5_revisions WHERE resource = ?')
      .get(w5ResourceKey(resource));
    return row ? asInteger(row.revision) : 0;
  }

  /** Runs synchronously on the worker's single exclusively held connection. */
  snapshot(): W5BackupPosition {
    return readW5BackupPosition(this.db);
  }

  /** Bounded retained evidence, not a claim of canonical revision eligibility. */
  captureEvidence(
    files: readonly { file: W5CaptureFile; path: string }[],
  ): W5CaptureEvidence {
    const limit = (): never => {
      throw new W5CommitRefusedError(
        'invalid-state',
        'The W5 capture exceeds its limits.',
        { capture: 'limit-exceeded' },
      );
    };
    if (files.length > W5_CAPTURE_LIMITS.files) limit();
    const revisions: Record<string, number> = {};
    Object.setPrototypeOf(revisions, null);
    let count = 0;
    const keys = new Set<string>();
    const prefixes = new Set<string>();
    for (const { file } of files) {
      switch (file.kind) {
        case 'index':
        case 'index-backup':
          keys.add('workspaces');
          break;
        case 'manifest':
          keys.add(`workspace:${file.workspaceId}`);
          break;
        case 'worktrees':
          keys.add(`worktrees:${file.workspaceId}`);
          prefixes.add(`worktree:${file.workspaceId}/`);
          break;
      }
    }
    const predicates = Array.from(keys, () => 'resource = ?');
    const parameters = Array.from(keys);
    prefixes.forEach((prefix): void => {
      // Binary ranges, not LIKE: IDs can contain underscores, and keys can contain NUL.
      predicates.push('(resource >= ? AND resource < ?)');
      parameters.push(prefix, `${prefix.slice(0, -1)}0`);
    });
    const revisionRows = this.db
      .prepare(
        `SELECT hex(substr(CAST(resource AS BLOB), 1, 2049)) AS resource, revision
         FROM w5_revisions WHERE ${predicates.join(' OR ') || '0'} ORDER BY resource`,
      )
      .iterate(...parameters);
    try {
      for (
        let next = revisionRows.next();
        !next.done;
        next = revisionRows.next()
      ) {
        const row = next.value;
        if (++count > W5_CAPTURE_LIMITS.evidenceRows) limit();
        // node:sqlite truncates TEXT results at NUL; bounded hex preserves the key.
        const key = Buffer.from(asText(row.resource), 'hex').toString('utf8');
        if (key.length > W5_CAPTURE_KEY_MAX) limit();
        revisions[key] = asInteger(row.revision);
      }
    } finally {
      revisionRows.return?.();
    }
    const evidence: W5FileLogEvidence[] = [];
    // The path's unapplied rows and its latest applied one. CROSS JOIN fixes
    // the loop order and INDEXED BY the ranges (`state != 'applied'` exactly),
    // so neither side walks the path's history: the first reads only
    // unresolved commits, the second stops at the newest applied row.
    const query = this.db.prepare(`SELECT commit_id, state,
      CASE WHEN previous IS NULL THEN NULL ELSE hex(substr(CAST(previous AS BLOB), 1, 65)) END AS previous_fingerprint,
      CASE WHEN image IS NULL THEN NULL ELSE hex(substr(CAST(image AS BLOB), 1, 65)) END AS new_fingerprint
      FROM (
        SELECT c.commit_id, c.state, f.previous_fingerprint AS previous, f.new_fingerprint AS image
        FROM w5_commits c INDEXED BY w5_commits_by_state CROSS JOIN w5_commit_files f
          ON f.commit_id = c.commit_id AND f.path = ?1
        WHERE c.state < 'applied' OR c.state > 'applied'
        UNION ALL
        SELECT * FROM (
          SELECT f.commit_id, c.state, f.previous_fingerprint, f.new_fingerprint
          FROM w5_commit_files f INDEXED BY w5_commit_files_by_path
          CROSS JOIN w5_commits c ON c.commit_id = f.commit_id
          WHERE f.path = ?1 AND c.state = 'applied'
          ORDER BY f.commit_id DESC LIMIT 1
        )
      ) ORDER BY commit_id`);
    for (const { file, path } of files) {
      const rows = query.iterate(path);
      try {
        for (let next = rows.next(); !next.done; next = rows.next()) {
          const row = next.value;
          if (++count > W5_CAPTURE_LIMITS.evidenceRows) limit();
          const state = asText(row.state);
          if (
            state !== 'committed' &&
            state !== 'applied' &&
            state !== 'recovery-required'
          )
            throw new W5CommitLogError(
              'STORAGE_UNAVAILABLE',
              'Unexpected commit state.',
            );
          const previousFingerprint =
            row.previous_fingerprint === null
              ? null
              : Buffer.from(asText(row.previous_fingerprint), 'hex').toString(
                  'utf8',
                );
          const newFingerprint =
            row.new_fingerprint === null
              ? null
              : Buffer.from(asText(row.new_fingerprint), 'hex').toString(
                  'utf8',
                );
          if (
            [previousFingerprint, newFingerprint].some(
              (value) => value !== null && !/^[a-f0-9]{64}$/.test(value),
            )
          )
            throw new W5CommitLogError(
              'STORAGE_UNAVAILABLE',
              'Unexpected fingerprint.',
            );
          evidence.push({
            file,
            commitId: asInteger(row.commit_id),
            state,
            previousFingerprint,
            newFingerprint,
          });
        }
      } finally {
        rows.return?.();
      }
    }
    // `state != 'applied'` as two index ranges, so only unresolved rows are read.
    const commits = this.db
      .prepare(
        `SELECT retained, (SELECT COUNT(*) FROM w5_commits INDEXED BY w5_commits_by_state
           WHERE state < 'applied' OR state > 'applied') AS unresolved
         FROM w5_commit_totals`,
      )
      .get();
    return {
      commitId: asInteger(
        this.db
          .prepare(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'w5_commits'), 0) AS id",
          )
          .get()?.id,
      ),
      retainedCommits: asInteger(commits?.retained),
      unresolvedCommits: asInteger(commits?.unresolved),
      schemaVersion: Number(
        asText(
          this.db
            .prepare("SELECT value FROM w5_meta WHERE key = 'schema_version'")
            .get()?.value,
        ),
      ),
      revisions,
      files: evidence,
      chains: this.chainEvidence(files),
      resourceRevisionEligibility: 'unproven',
    };
  }

  /**
   * One summary row per path, kept by the schema's triggers, so neither the
   * row limit nor the cost grows with history. A path without one has none.
   */
  private chainEvidence(
    files: readonly { file: W5CaptureFile; path: string }[],
  ): W5FileChainEvidence[] {
    const query = this.db.prepare(
      `SELECT decisions, starts_absent, discontinuities FROM w5_file_chains WHERE path = ?`,
    );
    return files.map(({ file, path }) => {
      const row = query.get(path);
      return {
        file,
        decisions: row ? asInteger(row.decisions) : 0,
        startsAbsent: row ? asInteger(row.starts_absent) === 1 : false,
        discontinuities: row ? asInteger(row.discontinuities) : 0,
      };
    });
  }

  /**
   * What a keyed request should do before any effect: replay a committed
   * outcome (whatever the target's state now), refuse a key reused with other
   * parameters, or wait for or recover an attempt still pending.
   */
  lookupReceipt(key: W5ReceiptKey, fingerprint: string): W5ReceiptLookup {
    const receipt = this.db
      .prepare(
        `SELECT r.fingerprint, r.commit_id, c.outcome_json, c.state,
                c.diagnostics_json, c.outcome_expired
           FROM w5_receipts r JOIN w5_commits c USING (commit_id)
          WHERE r.caller = ? AND r.operation = ? AND r.idempotency_key = ?`,
      )
      .get(key.caller, key.operation, key.idempotencyKey);
    if (receipt) {
      if (asText(receipt.fingerprint) !== fingerprint) {
        return { status: 'key-reused' };
      }
      // A replay never reports an outcome the files do not hold.
      if (asText(receipt.state) === 'recovery-required') {
        return {
          status: 'commit-recovery-required',
          commitId: asInteger(receipt.commit_id),
          diagnostics: parseJson(asNullableText(receipt.diagnostics_json)),
        };
      }
      if (asInteger(receipt.outcome_expired) === 1) {
        return {
          status: 'replay-expired',
          commitId: asInteger(receipt.commit_id),
        };
      }
      return {
        status: 'replay',
        commitId: asInteger(receipt.commit_id),
        outcome: parseJson(asText(receipt.outcome_json)),
      };
    }
    const reservation = this.db
      .prepare(
        `SELECT reservation_id, state, fingerprint, diagnostics_json
           FROM w5_reservations
          WHERE caller = ? AND operation = ? AND idempotency_key = ?`,
      )
      .get(key.caller, key.operation, key.idempotencyKey);
    if (!reservation) return { status: 'none' };
    if (asNullableText(reservation.fingerprint) !== fingerprint) {
      return { status: 'key-reused' };
    }
    const reservationId = asText(reservation.reservation_id);
    return asText(reservation.state) === 'reserved'
      ? { status: 'in-progress', reservationId }
      : {
          status: 'recovery-required',
          reservationId,
          diagnostics: parseJson(asText(reservation.diagnostics_json)),
        };
  }

  /**
   * Record an operation identity before effects that cannot be undone or
   * repeated safely (a clone, `git worktree add`). A reservation still held
   * at the next launch becomes `recovery-required`; its key cannot be reused
   * until the user resolves it.
   */
  reserve(input: {
    workspaceIdentity?: string;
    reservationId: string;
    operation: string;
    receipt?: W5ReceiptKey & { fingerprint: string };
    diagnostics: unknown;
  }): void {
    this.transaction(() => {
      if (input.receipt) {
        this.refuseUnlessKeyIsFree(input.receipt, input.receipt.fingerprint);
      }
      if (input.workspaceIdentity !== undefined) {
        const rival = this.db
          .prepare(
            `SELECT reservation_id FROM w5_reservations WHERE lower(workspace_identity) = lower(?)
             UNION ALL SELECT reservation_id FROM w5_legacy_workspace_claims
             WHERE workspace_identity IS NULL OR lower(workspace_identity) = lower(?)`,
          )
          .get(input.workspaceIdentity, input.workspaceIdentity);
        if (rival)
          throw new W5CommitRefusedError(
            'identity-conflict',
            'This workspace identity is already reserved.',
          );
      }
      this.db
        .prepare(
          `INSERT INTO w5_reservations
             (reservation_id, operation, caller, idempotency_key, fingerprint,
              state, diagnostics_json, reserved_at, workspace_identity)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        )
        .run(
          input.reservationId,
          input.operation,
          input.receipt?.caller ?? null,
          input.receipt?.idempotencyKey ?? null,
          input.receipt?.fingerprint ?? null,
          JSON.stringify(input.diagnostics ?? null),
          new Date(this.clock()).toISOString(),
          input.workspaceIdentity ?? null,
        );
    });
  }

  /** Update only the owning live identity's bounded, content-free recovery facts. */
  updateReservationDiagnostics(
    reservationId: string,
    diagnostics: WorkspaceCreationDiagnostics,
  ): void {
    const parsed = workspaceCreationDiagnosticsSchema.safeParse(diagnostics);
    if (
      !parsed.success ||
      Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') >
        W5_RESERVATION_DIAGNOSTICS_MAX_BYTES
    ) {
      throw new W5CommitRefusedError(
        'invalid-state',
        'Invalid reservation diagnostics.',
      );
    }
    this.transaction(() => {
      this.requireReservationState(reservationId, 'reserved');
      const row = this.db
        .prepare(
          'SELECT diagnostics_json FROM w5_reservations WHERE reservation_id = ?',
        )
        .get(reservationId);
      const previous = workspaceCreationDiagnosticsSchema.safeParse(
        row ? parseJson(asText(row.diagnostics_json)) : null,
      );
      if (
        !previous.success ||
        previous.data.workspaceId !== parsed.data.workspaceId
      ) {
        throw new W5CommitRefusedError(
          'invalid-state',
          'Reservation diagnostics identity does not match.',
        );
      }
      this.db
        .prepare(
          'UPDATE w5_reservations SET diagnostics_json = ? WHERE reservation_id = ?',
        )
        .run(JSON.stringify(parsed.data), reservationId);
    });
  }

  /** Drop a reservation whose operation failed before any uncertain effect. */
  releaseReservation(reservationId: string): void {
    this.transaction(() => {
      this.requireReservationState(reservationId, 'reserved');
      this.db
        .prepare('DELETE FROM w5_reservations WHERE reservation_id = ?')
        .run(reservationId);
    });
  }

  /** A failed live attempt is blocked immediately, without resuming or compensating. */
  markReservationRecoveryRequired(
    reservationId: string,
    diagnostics: W5ReservationFailureDiagnostics,
  ): void {
    this.transaction(() => {
      this.requireReservationState(reservationId, 'reserved');
      const row = this.db
        .prepare(
          'SELECT diagnostics_json FROM w5_reservations WHERE reservation_id = ?',
        )
        .get(reservationId);
      const previous = row ? asText(row.diagnostics_json) : 'null';
      // Keep owned-path evidence; error-only reservations retain failure facts.
      const keepCreation = workspaceCreationDiagnosticsSchema.safeParse(
        parseJson(previous),
      ).success;
      this.db
        .prepare(
          "UPDATE w5_reservations SET state = 'recovery-required', diagnostics_json = ? WHERE reservation_id = ?",
        )
        .run(
          keepCreation ? previous : JSON.stringify(diagnostics),
          reservationId,
        );
    });
  }

  /** The user resolved an interrupted operation; its key may be used again. */
  resolveRecovery(reservationId: string): void {
    this.transaction(() => {
      // A reservation still in progress is never resolved out from under it.
      this.requireReservationState(reservationId, 'recovery-required');
      this.db
        .prepare('DELETE FROM w5_reservations WHERE reservation_id = ?')
        .run(reservationId);
    });
  }

  /** Mark every reservation an earlier process left held as needing recovery. */
  markInterruptedReservations(): number {
    const result = this.db
      .prepare(
        `UPDATE w5_reservations SET state = 'recovery-required' WHERE state = 'reserved'`,
      )
      .run();
    return asInteger(result.changes);
  }

  listReservations(): W5Reservation[] {
    return this.db
      .prepare(
        `SELECT reservation_id, operation, state, diagnostics_json
           FROM w5_reservations ORDER BY reserved_at, reservation_id`,
      )
      .all()
      .map((row) => {
        const state = asText(row.state);
        return {
          reservationId: asText(row.reservation_id),
          operation: asText(row.operation),
          state: state === 'reserved' ? 'reserved' : 'recovery-required',
          diagnostics: parseJson(asText(row.diagnostics_json)),
        };
      });
  }

  /**
   * Commit a change. In one transaction: a keyed request whose receipt
   * already exists replays its outcome before any revision check; otherwise
   * every expected revision must match, each advanced revision moves by one,
   * and the file contents, outcome and receipt are recorded together. A
   * refusal changes nothing.
   */
  commit(request: W5CommitRequest): W5CommitResult {
    this.refuseListReservation(request);
    const result = this.transaction((): W5CommitResult => {
      const replay = this.replayOrAdmitKey(request);
      if (replay) return replay;
      this.refuseUndecidableCommit(request);
      return this.recordCommit(request);
    });
    if (result.status === 'committed') {
      this.commitsSinceCompaction += 1;
      if (this.commitsSinceCompaction >= W5_COMPACTION_INTERVAL) this.compact();
    }
    return result;
  }

  /**
   * The typed refusals a decision would raise, in order, deciding nothing: a
   * file recheck must not hide why this commit could never have been decided.
   */
  refuseInadmissibleCommit(request: W5CommitRequest): void {
    this.refuseListReservation(request);
    this.refuseUndecidableCommit(request);
  }

  /** This low-level repository operation has never owned external effects. */
  private refuseListReservation(request: W5CommitRequest): void {
    // Composite/reserved producers must use their semantic operation name.
    if (
      request.operation === 'w5.worktree_list.write' &&
      request.reservationId !== undefined
    )
      throw new W5CommitRefusedError(
        'invalid-state',
        'A list update cannot complete a worktree operation reservation.',
      );
  }

  private refuseUndecidableCommit(request: W5CommitRequest): void {
    this.refuseUnlessReservationIsHeld(request);
    this.refuseStaleRevisions(request.expectedRevisions ?? []);
    this.refuseUnappliedChanges(request.files);
  }

  /**
   * A keyed request replays its committed outcome; otherwise its key must be
   * free, or held by the reservation this commit completes.
   */
  private replayOrAdmitKey(request: W5CommitRequest): W5CommitResult | null {
    if (!request.receipt) return null;
    const lookup = this.lookupReceipt(
      request.receipt,
      request.receipt.fingerprint,
    );
    if (lookup.status === 'replay') {
      return {
        status: 'replayed',
        commitId: lookup.commitId,
        outcome: lookup.outcome,
      };
    }
    if (lookup.status === 'replay-expired') return lookup;
    const ownReservation =
      lookup.status === 'in-progress' &&
      lookup.reservationId === request.reservationId;
    if (!ownReservation) {
      this.refuseUnlessKeyIsFree(request.receipt, request.receipt.fingerprint);
    }
    return null;
  }

  /**
   * A commit may only complete a reservation that is still held, and a
   * keyed one only the reservation of its own key and parameters. A
   * reservation awaiting recovery stays until the user resolves it.
   */
  private refuseUnlessReservationIsHeld(request: W5CommitRequest): void {
    for (const file of request.files) {
      if (basename(file.path) !== 'workspace.json') continue;
      const identity = basename(dirname(file.path));
      const claim = this.db
        .prepare(
          `SELECT reservation_id FROM w5_reservations
             WHERE lower(workspace_identity) = lower(?) AND reservation_id != ?
           UNION ALL SELECT reservation_id FROM w5_legacy_workspace_claims
             WHERE ((workspace_identity IS NULL AND ? IS NULL) OR lower(workspace_identity) = lower(?))
             AND reservation_id != ?`,
        )
        .get(
          identity,
          request.reservationId ?? '',
          file.previousFingerprint,
          identity,
          request.reservationId ?? '',
        );
      if (claim)
        throw new W5CommitRefusedError(
          'identity-conflict',
          'This workspace identity belongs to another creation.',
          { workspaceIdentity: identity },
        );
    }
    if (request.reservationId === undefined) return;
    const reservation = this.db
      .prepare(
        `SELECT state, caller, operation, idempotency_key, fingerprint
           FROM w5_reservations WHERE reservation_id = ?`,
      )
      .get(request.reservationId);
    if (!reservation) {
      throw new W5CommitRefusedError(
        'unknown-reservation',
        'This operation is no longer reserved.',
        { reservationId: request.reservationId },
      );
    }
    if (asText(reservation.state) !== 'reserved') {
      throw new W5CommitRefusedError(
        'recovery-required',
        'An earlier attempt of this request was interrupted and needs recovery.',
        { reservationId: request.reservationId },
      );
    }
    const receipt = request.receipt;
    const ownKey =
      receipt === undefined
        ? reservation.idempotency_key === null
        : asNullableText(reservation.caller) === receipt.caller &&
          asNullableText(reservation.operation) === receipt.operation &&
          asNullableText(reservation.idempotency_key) ===
            receipt.idempotencyKey &&
          asNullableText(reservation.fingerprint) === receipt.fingerprint;
    if (!ownKey) {
      throw new W5CommitRefusedError(
        'key-reused',
        'This reservation belongs to another request.',
        { reservationId: request.reservationId },
      );
    }
  }

  private refuseStaleRevisions(
    expectedRevisions: NonNullable<W5CommitRequest['expectedRevisions']>,
  ): void {
    for (const expected of expectedRevisions) {
      const actual = this.revision(expected.resource);
      if (actual !== expected.revision) {
        throw new W5CommitRefusedError(
          'revision-conflict',
          'This was changed since it was read. Reload and try again.',
          {
            resource: w5ResourceKey(expected.resource),
            expected: expected.revision,
            actual,
          },
        );
      }
    }
  }

  private recordCommit(request: W5CommitRequest): W5CommitResult {
    const commitId = asInteger(
      this.db
        .prepare(
          `INSERT INTO w5_commits (operation, outcome_json, state, committed_at)
           VALUES (?, ?, 'committed', ?)`,
        )
        .run(
          request.operation,
          JSON.stringify(request.outcome ?? null),
          new Date(this.clock()).toISOString(),
        ).lastInsertRowid,
    );
    const insertFile = this.db.prepare(
      `INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, contents, new_fingerprint)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const file of request.files) {
      insertFile.run(
        commitId,
        file.path,
        file.previousFingerprint,
        file.contents,
        fingerprintW5File(file.contents),
      );
    }
    const revisions = this.advanceRevisions(request.advance);
    if (request.receipt) {
      this.db
        .prepare(
          `INSERT INTO w5_receipts
             (caller, operation, idempotency_key, fingerprint, commit_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          request.receipt.caller,
          request.receipt.operation,
          request.receipt.idempotencyKey,
          request.receipt.fingerprint,
          commitId,
        );
    }
    if (request.reservationId !== undefined) {
      this.db
        .prepare('DELETE FROM w5_reservations WHERE reservation_id = ?')
        .run(request.reservationId);
    }
    return { status: 'committed', commitId, revisions };
  }

  private advanceRevisions(
    resources: readonly W5Resource[],
  ): Record<string, number> {
    const revisions: Record<string, number> = {};
    const upsertRevision = this.db.prepare(
      `INSERT INTO w5_revisions (resource, revision) VALUES (?, 1)
       ON CONFLICT (resource) DO UPDATE SET revision = revision + 1
       RETURNING revision`,
    );
    for (const resource of resources) {
      const key = w5ResourceKey(resource);
      if (key in revisions) continue;
      revisions[key] = asInteger(upsertRevision.get(key)?.revision);
    }
    return revisions;
  }

  /** Committed changes not yet written to their files, oldest first. */
  listPendingCommits(): W5PendingCommit[] {
    const files = this.db.prepare(
      `SELECT path, previous_fingerprint, contents FROM w5_commit_files
        WHERE commit_id = ? ORDER BY path`,
    );
    return this.db
      .prepare(
        `SELECT commit_id, operation FROM w5_commits
          WHERE state = 'committed' ORDER BY commit_id`,
      )
      .all()
      .map((row) => {
        const commitId = asInteger(row.commit_id);
        return {
          commitId,
          operation: asText(row.operation),
          files: files.all(commitId).map((file) => ({
            path: asText(file.path),
            previousFingerprint: asNullableText(file.previous_fingerprint),
            contents: asNullableText(file.contents),
          })),
        };
      });
  }

  /** Local paths for an explicit retry's execution-owner lock. */
  recoveryCommitPaths(commitId: number): string[] {
    return this.db
      .prepare(
        'SELECT path FROM w5_commit_files WHERE commit_id = ? ORDER BY path',
      )
      .all(commitId)
      .map((row) => asText(row.path));
  }

  /** Commits waiting for manual recovery, oldest first. */
  listRecoveryRequiredCommitIds(): number[] {
    return this.db
      .prepare(
        `SELECT commit_id FROM w5_commits
          WHERE state = 'recovery-required' ORDER BY commit_id`,
      )
      .all()
      .map((row) => asInteger(row.commit_id));
  }

  /** Local recovery evidence, never a wire DTO. Invalid JSON remains ineligible. */
  listRecoveryRequiredCommits(): Array<{
    commitId: number;
    operation: string;
    hasReceipt: boolean;
    fileCount: number;
    diagnostics: { conflicts: W5FileConflict[]; written: string[] } | undefined;
    /** Its apply stopped on a transient I/O error before writing anything. */
    transientFailure: boolean;
  }> {
    return this.db
      .prepare(
        `SELECT c.commit_id, c.operation, c.diagnostics_json,
      EXISTS(SELECT 1 FROM w5_receipts r WHERE r.commit_id = c.commit_id) AS has_receipt,
      (SELECT COUNT(*) FROM w5_commit_files f WHERE f.commit_id = c.commit_id) AS file_count
      FROM w5_commits c WHERE c.state = 'recovery-required' ORDER BY c.commit_id`,
      )
      .all()
      .map((row) => {
        let evidence: unknown;
        try {
          evidence = parseJson(asNullableText(row.diagnostics_json));
        } catch {
          evidence = undefined;
        }
        return {
          commitId: asInteger(row.commit_id),
          operation: asText(row.operation),
          hasReceipt: asInteger(row.has_receipt) !== 0,
          fileCount: asInteger(row.file_count),
          diagnostics: isCleanConflictEvidence(evidence) ? evidence : undefined,
          transientFailure: isTransientUnwrittenFailureEvidence(evidence),
        };
      });
  }

  /** Content-free apply diagnostics for the host's launch report. */
  listRecoveryRequiredCommitDiagnostics(): Array<{
    commitId: number;
    conflictCount: number;
    writtenFileCount: number;
    unexpectedFailure: boolean;
  }> {
    return this.db
      .prepare(
        `SELECT commit_id, diagnostics_json FROM w5_commits
        WHERE state = 'recovery-required' ORDER BY commit_id`,
      )
      .all()
      .map((row) => {
        let value: unknown;
        try {
          value = parseJson(asNullableText(row.diagnostics_json));
        } catch {
          value = undefined;
        }
        const diagnostics =
          typeof value === 'object' && value !== null ? value : {};
        const conflicts: unknown = Reflect.get(diagnostics, 'conflicts');
        const written: unknown = Reflect.get(diagnostics, 'written');
        return {
          commitId: asInteger(row.commit_id),
          conflictCount: Array.isArray(conflicts) ? conflicts.length : 0,
          writtenFileCount: Array.isArray(written) ? written.length : 0,
          unexpectedFailure:
            typeof Reflect.get(diagnostics, 'error') === 'string',
        };
      });
  }

  markApplied(commitId: number): void {
    this.transaction(() => {
      this.requireCommitState(commitId, 'committed');
      this.db
        .prepare(
          `UPDATE w5_commits SET state = 'applied', completed_at = ? WHERE commit_id = ?`,
        )
        .run(new Date(this.clock()).toISOString(), commitId);
      this.db
        .prepare(
          'UPDATE w5_commit_files SET contents = NULL WHERE commit_id = ?',
        )
        .run(commitId);
    });
  }

  /**
   * One bounded batch, after launch recovery and every 100 new commits.
   * Identities, completion times and file fingerprints are never removed.
   * Pending commits and reservations are ineligible. SQLite reuses the freed
   * pages for later writes; this does not VACUUM on the commit path.
   */
  compact(): number {
    const cutoff = new Date(this.clock() - this.retryWindowMs).toISOString();
    const changed = this.transaction(
      () =>
        this.db
          .prepare(
            `UPDATE w5_commits SET outcome_json = 'null', outcome_expired = 1
       WHERE commit_id IN (
         SELECT commit_id FROM w5_commits
         WHERE state = 'applied' AND outcome_expired = 0 AND completed_at < ?
         ORDER BY completed_at, commit_id LIMIT ?
       )`,
          )
          .run(cutoff, W5_COMPACTION_BATCH_SIZE).changes,
    );
    this.commitsSinceCompaction = 0;
    return asInteger(changed);
  }

  /**
   * The user restored the files of a commit awaiting recovery: put it back in
   * the apply flow, where its files are checked against both sides again and
   * it is flagged once more if they still match neither.
   */
  retryRecoveryRequiredCommit(commitId: number): void {
    this.transaction(() => {
      this.requireCommitState(commitId, 'recovery-required');
      this.db
        .prepare(
          `UPDATE w5_commits SET state = 'committed', diagnostics_json = NULL
            WHERE commit_id = ?`,
        )
        .run(commitId);
    });
  }

  /**
   * The user kept the files as they are: drop a commit awaiting recovery.
   * Its changes never reached the files, so its receipt goes too and a retry
   * with the same key runs again (receipts never claim an outcome the files
   * do not hold). Its revision advances stay: revisions only move forward.
   */
  abandonRecoveryRequiredCommit(commitId: number): void {
    this.transaction(() => {
      this.requireCommitState(commitId, 'recovery-required');
      this.db
        .prepare('DELETE FROM w5_receipts WHERE commit_id = ?')
        .run(commitId);
      this.db
        .prepare('DELETE FROM w5_commit_files WHERE commit_id = ?')
        .run(commitId);
      this.db
        .prepare('DELETE FROM w5_commits WHERE commit_id = ?')
        .run(commitId);
    });
  }

  /** A file changed out of band; the commit waits for manual recovery. */
  markCommitRecoveryRequired(commitId: number, diagnostics: unknown): void {
    this.transaction(() => {
      this.requireCommitState(commitId, 'committed');
      this.db
        .prepare(
          `UPDATE w5_commits SET state = 'recovery-required', diagnostics_json = ?
            WHERE commit_id = ?`,
        )
        .run(JSON.stringify(diagnostics ?? null), commitId);
    });
  }

  private requireCommitState(
    commitId: number,
    state: 'committed' | 'recovery-required',
  ): void {
    const row = this.db
      .prepare('SELECT state FROM w5_commits WHERE commit_id = ?')
      .get(commitId);
    const actual = row ? asText(row.state) : 'missing';
    if (actual !== state) {
      throw new W5CommitRefusedError(
        'invalid-state',
        'This change is not in a state that allows this action.',
        { commitId, expected: state, actual },
      );
    }
  }

  private requireReservationState(
    reservationId: string,
    state: 'reserved' | 'recovery-required',
  ): void {
    const row = this.db
      .prepare('SELECT state FROM w5_reservations WHERE reservation_id = ?')
      .get(reservationId);
    const actual = row ? asText(row.state) : 'missing';
    if (actual !== state) {
      throw new W5CommitRefusedError(
        'invalid-state',
        'This operation is not in a state that allows this action.',
        { reservationId, expected: state, actual },
      );
    }
  }

  private refuseUnlessKeyIsFree(key: W5ReceiptKey, fingerprint: string): void {
    const lookup = this.lookupReceipt(key, fingerprint);
    switch (lookup.status) {
      case 'none':
        return;
      case 'replay':
        throw new W5CommitRefusedError(
          'key-reused',
          'This request was already completed.',
          { commitId: lookup.commitId },
        );
      case 'replay-expired':
        throw new W5CommitRefusedError(
          'outcome-expired',
          'This request was already completed; its saved outcome has expired.',
          { commitId: lookup.commitId },
        );
      case 'key-reused':
        throw new W5CommitRefusedError(
          'key-reused',
          'This request was already completed with different details.',
        );
      case 'commit-recovery-required':
        throw new W5CommitRefusedError(
          'recovery-required',
          'This request was saved but did not finish and needs recovery.',
          { commitId: lookup.commitId },
        );
      case 'in-progress':
        throw new W5CommitRefusedError(
          'in-progress',
          'This request is still in progress.',
          { reservationId: lookup.reservationId },
        );
      case 'recovery-required':
        throw new W5CommitRefusedError(
          'recovery-required',
          'An earlier attempt of this request was interrupted and needs recovery.',
          { reservationId: lookup.reservationId },
        );
    }
  }

  /**
   * A change computed from the files on disk would lose a committed change
   * that has not reached them yet, so it waits until that one is applied.
   */
  private refuseUnappliedChanges(files: readonly W5FileChange[]): void {
    // Unresolved commits first: starting from the path index walks the file's
    // whole history on every commit. IN keeps two index searches (a range
    // pair would scan the index under ORDER BY); state allows only these two
    // values besides 'applied'.
    const pending = this.db.prepare(
      `SELECT c.commit_id, c.operation
        FROM w5_commits c INDEXED BY w5_commits_by_state CROSS JOIN w5_commit_files f
          ON f.commit_id = c.commit_id AND f.path = ?
        WHERE c.state IN ('committed', 'recovery-required')
        ORDER BY c.commit_id LIMIT 1`,
    );
    for (const file of files) {
      const row = pending.get(file.path);
      if (row) {
        throw new W5CommitRefusedError(
          'unapplied-change',
          `An earlier change (commit ${asInteger(row.commit_id)}, ${asText(row.operation)}) to ${file.path} has not finished saving.`,
          {
            path: file.path,
            commitId: asInteger(row.commit_id),
            operation: asText(row.operation),
          },
        );
      }
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
