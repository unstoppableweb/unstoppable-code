import { statSync } from 'node:fs';
import * as path from 'node:path';
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
} from '../types/code-graph';
import {
  isPublishedCodeGraphBaseDatabaseValid,
  openReadonlyDatabase,
  readCodeGraphSummaryProjection,
  type CodeGraphBaseIdentity,
} from '../base-graph';
import { CodeGraphQueryService } from '../query/queries';
import { CodeGraphStore } from '../store/graph-store';
import {
  getMetadataValue,
  openCodeGraphDatabase,
  readCodeGraphFingerprintMetadata,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import {
  CodeGraphWriterLeaseBusyError,
  withCodeGraphWriterLease,
} from '../store/writer-lease';
import { buildCodeGraphSnapshot } from '../snapshot/export';
import {
  applyCodeGraphSnapshot,
  type CodeGraphSnapshotImportResult,
} from '../snapshot/import';
import type { CodeGraphSnapshotEnvelope } from '../types/code-graph-tools';
import { getDiffRanges } from '../git/diff';
import { mapRangesToSymbols } from '../impact/changed-symbols';
import { assembleChangeImpact } from '../impact/change-impact';
import {
  customLanguagesConfigPath,
  resolveCustomLanguages,
} from '../languages/custom-config';
import { CodeGraphParserRuntime } from '../parser/runtime';
import type {
  CodeGraphBaseIdentityReadResult,
  CodeGraphLanguagesValidation,
  CodeGraphReadCall,
  CodeGraphWorkerReadRequest,
  CodeGraphWorkerReadResponse,
} from './read-protocol';

function containsAsciiIdentityControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f) return true;
  }
  return false;
}

/**
 * The graph's last build time, exactly as `readStatus` reports it, from
 * metadata alone: detect-changed and change-impact need only this value, not
 * the status read's full-table counts.
 */
export function readLastBuildAt(db: CodeGraphDatabase): number | null {
  const lastBuildRaw = getMetadataValue(db, 'last_build_at');
  return lastBuildRaw === null ? null : Number(lastBuildRaw);
}

export function classifyCodeGraphReadDatabaseError(
  error: unknown,
): 'permission-denied' | 'busy' | 'corrupt' | 'unsupported-schema' | 'io' {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  const sqliteCode =
    typeof error === 'object' && error !== null && 'errcode' in error
      ? error.errcode
      : undefined;
  const primary = typeof sqliteCode === 'number' ? sqliteCode & 255 : undefined;
  const message = error instanceof Error ? error.message.slice(0, 512) : '';
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    primary === 3 ||
    primary === 8 ||
    primary === 23
  )
    return 'permission-denied';
  if (
    primary === 5 ||
    primary === 6 ||
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /database is (busy|locked)/i.test(message)
  )
    return 'busy';
  if (
    primary === 11 ||
    primary === 26 ||
    /not a database|database disk image is malformed/i.test(message)
  )
    return 'corrupt';
  if (
    primary === 1 ||
    primary === 17 ||
    /no such table|no such column|unsupported schema/i.test(message)
  )
    return 'unsupported-schema';
  return 'io';
}

function safeMarker(value: unknown): number | null {
  if (
    typeof value !== 'string' ||
    value.length > 16 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  )
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Metadata plus a bounded sole-repository HEADER; not an integrity check. */
export function readCodeGraphBaseIdentity(
  dbPath: string,
  identity: CodeGraphBaseIdentity,
  gitHead: string | null,
): CodeGraphBaseIdentityReadResult {
  let db: CodeGraphDatabase | undefined;
  let transaction = false;
  try {
    if (
      dbPath.length === 0 ||
      dbPath.length > 32768 ||
      dbPath.includes('\0') ||
      !path.isAbsolute(dbPath) ||
      identity.canonicalRepoRoot.length === 0 ||
      identity.canonicalRepoRoot.length > 32768 ||
      identity.canonicalRepoRoot.includes('\0') ||
      !path.isAbsolute(identity.canonicalRepoRoot) ||
      identity.repoId.length === 0 ||
      identity.repoId.length > 1024 ||
      identity.customLanguagesFingerprint.length > 256 ||
      (gitHead !== null && gitHead.length > 512)
    ) {
      return { state: 'error', classification: 'io' };
    }
    try {
      statSync(dbPath);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return { state: 'missing' };
      throw error;
    }
    db = openReadonlyDatabase(dbPath);
    db.exec('BEGIN');
    transaction = true;
    const metadata = db
      .prepare(
        `SELECT key, substr(value, 1, 32769) AS value FROM graph_metadata
      WHERE key IN ('schema_version', 'extractor_version', 'base_canonical_repo_root',
        'custom_languages_fingerprint', 'last_build_at', 'completed_build_at')`,
      )
      .all();
    const values = new Map<string, unknown>();
    for (const row of metadata) {
      if (
        typeof row === 'object' &&
        row !== null &&
        'key' in row &&
        'value' in row &&
        typeof row.key === 'string'
      )
        values.set(row.key, row.value);
    }
    const rows = db
      .prepare(
        `SELECT
      CASE WHEN typeof(repo_id) = 'text' AND length(CAST(repo_id AS BLOB)) <= 1024
        THEN substr(repo_id, 1, 1024) ELSE NULL END AS repo_id,
      CASE WHEN git_head IS NULL THEN NULL
        WHEN typeof(git_head) = 'text' AND length(CAST(git_head AS BLOB)) <= 512
        THEN substr(git_head, 1, 512) ELSE NULL END AS git_head,
      CASE WHEN typeof(repo_id) != 'text' OR length(CAST(repo_id AS BLOB)) > 1024
        THEN 1 ELSE 0 END AS repo_id_invalid,
      CASE WHEN git_head IS NOT NULL AND (typeof(git_head) != 'text' OR length(CAST(git_head AS BLOB)) > 512)
        THEN 1 ELSE 0 END AS git_head_invalid
      FROM repositories LIMIT 2`,
      )
      .all();
    for (const row of rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('repo_id_invalid' in row) ||
        !('git_head_invalid' in row) ||
        row.repo_id_invalid !== 0 ||
        row.git_head_invalid !== 0
      )
        throw new Error('Invalid repository header.');
    }
    const sole = rows.length === 1 ? rows[0] : undefined;
    const repository =
      typeof sole === 'object' &&
      sole !== null &&
      'repo_id' in sole &&
      'git_head' in sole &&
      typeof sole.repo_id === 'string' &&
      sole.repo_id.length <= 1024 &&
      !/[\\/]/.test(sole.repo_id) &&
      !containsAsciiIdentityControl(sole.repo_id) &&
      (sole.git_head === null ||
        (typeof sole.git_head === 'string' &&
          sole.git_head.length <= 512 &&
          !/[\\/]/.test(sole.git_head) &&
          !containsAsciiIdentityControl(sole.git_head)))
        ? { repoId: sole.repo_id, gitHead: sole.git_head }
        : null;
    const observed = {
      schemaVersion: safeMarker(values.get('schema_version')),
      extractorVersion: safeMarker(values.get('extractor_version')),
      lastBuildAt: safeMarker(values.get('last_build_at')),
      completedBuildAt: safeMarker(values.get('completed_build_at')),
    };
    const matches = {
      schema: observed.schemaVersion === CODE_GRAPH_SCHEMA_VERSION,
      extractor: observed.extractorVersion === CODE_GRAPH_EXTRACTOR_VERSION,
      canonicalRoot:
        values.get('base_canonical_repo_root') === identity.canonicalRepoRoot,
      customLanguagesFingerprint:
        values.get('custom_languages_fingerprint') ===
        identity.customLanguagesFingerprint,
      repoId: repository !== null && repository.repoId === identity.repoId,
      gitHead: repository !== null && repository.gitHead === gitHead,
      completed: observed.completedBuildAt !== null,
    };
    db.exec('COMMIT');
    transaction = false;
    return { state: 'readable', matches, observed, repository };
  } catch (error) {
    return {
      state: 'error',
      classification: classifyCodeGraphReadDatabaseError(error),
    };
  } finally {
    if (db !== undefined) {
      if (transaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* Already closed/failed. */
        }
      }
      try {
        db.close();
      } catch {
        /* Result never exposes close details. */
      }
    }
  }
}

function executeCall(
  call: CodeGraphReadCall,
  queries: CodeGraphQueryService,
): unknown {
  switch (call.method) {
    case 'relationship-path':
      return queries.getRelationshipPath(call.options);
    case 'status':
      throw new Error('Invalid status task.');
    case 'file-summary':
      return queries.getFileSummary(call.target, call.repoId);
    case 'scripts-for-file':
      return queries.getScriptsForFile(call.target, call.repoId);
    case 'ipc-channel':
      return queries.getIpcChannel(call.target, call.repoId);
    case 'derived-stats':
      return queries.getDerivedStats(call.repoId);
    case 'communities':
      return queries.listCommunities(call.repoId, call.limit);
    case 'flows':
      return queries.listFlows(call.repoId, call.limit);
    case 'flows-for-symbol':
      return queries.listFlowsForSymbol(call.target, call.repoId, call.limit);
    case 'hubs':
      return queries.listTopDegreeSymbols(call.repoId, call.limit);
    case 'callers':
      return queries.getCallers(call.target, call.repoId);
    case 'callees':
      return queries.getCallees(call.target, call.repoId);
    case 'importers':
      return queries.getImporters(call.target, call.repoId);
    case 'imports':
      return queries.getImports(call.target, call.repoId);
    case 'children':
      return queries.getChildren(call.target, call.repoId);
    case 'tests-for':
      return queries.getTestsFor(call.target, call.repoId);
    case 'docs-for':
      return queries.getDocsFor(call.target, call.repoId);
    case 'rationale-for':
      return queries.getRationaleFor(call.target, call.repoId);
    case 'search':
      return queries.search(call.query, call.limit);
    case 'symbol-detail':
      return queries.getSymbolDetail(call.target, call.repoId);
    case 'community-for-symbol':
      return queries.getCommunityForSymbol(call.target, call.repoId);
    case 'impact-radius':
      return queries.getImpactRadius(call.target, call.options);
  }
}

/** How long an import waits for a build or another writer before it is refused as busy. */
const SNAPSHOT_IMPORT_LEASE_WAIT_MS = 5_000;

/**
 * Replaces one repository's graph under the cross-process writer lease, so it
 * never runs beside a build or another writer of the same database.
 */
async function importCodeGraphSnapshot(
  dbPath: string,
  repoId: string,
  rootPath: string,
  envelope: CodeGraphSnapshotEnvelope,
): Promise<CodeGraphSnapshotImportResult> {
  return withCodeGraphWriterLease(
    dbPath,
    async () => {
      const db = openCodeGraphDatabase(dbPath);
      try {
        runCodeGraphMigrations(db);
        return await applyCodeGraphSnapshot({
          store: new CodeGraphStore(db),
          db,
          repoId,
          rootPath,
          envelope,
        });
      } finally {
        db.close();
      }
    },
    { waitMs: SNAPSHOT_IMPORT_LEASE_WAIT_MS },
  );
}

/**
 * Loads each custom grammar and compiles its tags queries, as a build would.
 * The grammars stay loaded until this worker exits, which it does after
 * answering.
 */
async function validateLanguagesWithGrammars(
  worktreeRoot: string,
  resourcesDir: string,
): Promise<CodeGraphLanguagesValidation> {
  const runtime = await CodeGraphParserRuntime.create(resourcesDir);
  try {
    const outcome = await resolveCustomLanguages({
      configPath: customLanguagesConfigPath(worktreeRoot),
      runtime,
    });
    if (outcome.kind === 'absent')
      return { config: 'absent', languages: [], diagnostics: [] };
    if (outcome.kind === 'config-error')
      return {
        config: 'invalid',
        languages: [],
        diagnostics: [{ entryId: null, index: -1, message: outcome.error }],
      };
    const { loaded, diagnostics } = outcome.report;
    return {
      config: 'present',
      languages: loaded.map(({ id, extensions, index, abiVersion }) => ({
        id,
        extensions,
        index,
        abiVersion,
      })),
      diagnostics: diagnostics.map(({ entryId, index, message }) => ({
        entryId,
        index,
        message,
      })),
    };
  } finally {
    runtime.dispose();
  }
}

interface ReadConnection {
  db: CodeGraphDatabase;
  store: CodeGraphStore;
  queries: CodeGraphQueryService;
}

interface ReadConnectionLease {
  connection: ReadConnection;
  /** Ends the request; a failed request never leaves its connection cached. */
  release: (failed: boolean) => void;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

function fileIdentity(dbPath: string): FileIdentity | null {
  try {
    const stats = statSync(dbPath, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The same completion rule as `hasCompletedCodeGraph`, on an open handle. */
function hasCompletedBuild(db: CodeGraphDatabase): boolean {
  try {
    return (
      getMetadataValue(db, 'completed_build_at') !== null ||
      getMetadataValue(db, 'last_build_at') !== null
    );
  } catch {
    return false;
  }
}

/**
 * SQLite's schema cookie, which every schema change in any connection bumps.
 * Null if it cannot be read, which never matches a kept connection.
 */
function schemaCookie(db: CodeGraphDatabase): number | null {
  try {
    const row = db.prepare('PRAGMA schema_version').get();
    const value =
      typeof row === 'object' && row !== null && 'schema_version' in row
        ? row.schema_version
        : null;
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

function closeQuietly(db: CodeGraphDatabase): void {
  try {
    db.close();
  } catch {
    // `DatabaseSync.close()` throws only for a connection that is already
    // closed, so a failure leaves no handle open.
  }
}

function openReadConnection(dbPath: string): ReadConnection {
  const db = openReadonlyDatabase(dbPath);
  return {
    db,
    store: new CodeGraphStore(db),
    queries: new CodeGraphQueryService(db),
  };
}

/**
 * The one read-only connection a long-lived read worker keeps between
 * requests. Its first statement in a process costs 10-40 ms (WAL shared-memory
 * setup); a kept connection answers in microseconds.
 *
 * A kept connection must never answer for a different file. Before every
 * request the worker stats `dbPath` and reuses the connection only if the path
 * still names the same file (device and inode); a replaced, deleted or
 * recreated database is closed and reopened, and a missing one fails exactly
 * as a fresh open does. The file cannot be swapped under an open handle
 * without the path changing identity: its inode stays allocated while open.
 * Data changes made inside the same file (builds) are SQLite's to show: every
 * read transaction sees the latest commit. A schema change inside the same file
 * (an in-place migration such as phase 18's v3 to v4) also changes the schema
 * cookie, and the worker then reopens rather than reuse a connection: the read
 * path keeps per-connection facts about the schema (`hasFragmentFts`), so only
 * a connection opened under the current schema answers exactly as a fresh
 * reader does.
 *
 * A connection is kept only for a graph with a completed build, the graphs a
 * seed install never replaces (it replaces only incomplete ones), so a kept
 * handle never blocks that replacement on Windows. Worktree removal kills and
 * awaits the worker before it removes the file. Opens stay read-only and
 * never migrate.
 */
export class CodeGraphReadConnectionCache {
  private cached:
    | (ReadConnection & {
        dbPath: string;
        identity: FileIdentity;
        /** The schema cookie when the connection opened. */
        schema: number;
      })
    | null = null;

  public lease(dbPath: string): ReadConnectionLease {
    const before = fileIdentity(dbPath);
    const cached = this.cached;
    if (cached !== null) {
      if (
        cached.dbPath === dbPath &&
        before !== null &&
        sameFile(cached.identity, before) &&
        schemaCookie(cached.db) === cached.schema
      ) {
        return { connection: cached, release: (failed) => this.dropIf(failed) };
      }
      this.close();
    }
    const connection = openReadConnection(dbPath);
    // Read before any query, so a schema change after this point always
    // shows up as a different cookie on the next request.
    const schema = schemaCookie(connection.db);
    // Identical before and after the open, so the handle is on that file,
    // not on one renamed into place while it opened.
    const after = fileIdentity(dbPath);
    if (
      before !== null &&
      after !== null &&
      sameFile(before, after) &&
      schema !== null &&
      hasCompletedBuild(connection.db)
    ) {
      this.cached = { ...connection, dbPath, identity: before, schema };
      return { connection, release: (failed) => this.dropIf(failed) };
    }
    return { connection, release: () => closeQuietly(connection.db) };
  }

  public close(): void {
    const cached = this.cached;
    this.cached = null;
    if (cached !== null) closeQuietly(cached.db);
  }

  private dropIf(failed: boolean): void {
    if (failed) this.close();
  }
}

/**
 * Answers one request. With `connections` (the serving loop) a read reuses the
 * worker's kept connection when it is still valid; without it (one-shot
 * callers and tests) the read opens and closes its own, as before pooling.
 */
export async function executeCodeGraphRead(
  request: CodeGraphWorkerReadRequest,
  connections?: CodeGraphReadConnectionCache,
): Promise<CodeGraphWorkerReadResponse> {
  let release: ((failed: boolean) => void) | undefined;
  let failed = false;
  try {
    if (request.task.kind === 'snapshot-import') {
      connections?.close();
      return {
        ok: true,
        result: {
          kind: 'snapshot-import',
          value: await importCodeGraphSnapshot(
            request.dbPath,
            request.task.repoId,
            request.task.rootPath,
            request.task.envelope,
          ),
        },
      };
    }
    if (request.task.kind === 'languages-validate') {
      return {
        ok: true,
        result: {
          kind: 'languages-validate',
          value: await validateLanguagesWithGrammars(
            request.task.worktreeRoot,
            request.task.resourcesDir,
          ),
        },
      };
    }
    if (request.task.kind === 'validate-base') {
      return {
        ok: true,
        result: {
          kind: 'validate-base',
          value: isPublishedCodeGraphBaseDatabaseValid(request.dbPath, {
            ...request.task.identity,
            gitHead: request.task.gitHead,
          }),
        },
      };
    }
    if (request.task.kind === 'readonly-summary') {
      return {
        ok: true,
        result: {
          kind: 'readonly-summary',
          value: readCodeGraphSummaryProjection(request.dbPath),
        },
      };
    }

    if (request.task.kind === 'base-identity') {
      return {
        ok: true,
        result: {
          kind: 'base-identity',
          value: readCodeGraphBaseIdentity(
            request.dbPath,
            request.task.identity,
            request.task.gitHead,
          ),
        },
      };
    }
    if (
      request.task.kind === 'calls' &&
      request.task.calls.length > 0 &&
      request.task.calls.every((call) => call.method === 'status')
    ) {
      return {
        ok: true,
        result: {
          kind: 'calls',
          value: request.task.calls.map(() =>
            readCodeGraphSummaryProjection(request.dbPath),
          ),
        },
      };
    }

    let lease: ReadConnectionLease;
    if (connections === undefined) {
      const connection = openReadConnection(request.dbPath);
      lease = { connection, release: (): void => closeQuietly(connection.db) };
    } else {
      lease = connections.lease(request.dbPath);
    }
    release = lease.release;
    const { db, store, queries } = lease.connection;
    if (request.task.kind === 'fingerprint-metadata') {
      // The scheduler asks for this on every staleness check: metadata only.
      return {
        ok: true,
        result: {
          kind: 'fingerprint-metadata',
          value: readCodeGraphFingerprintMetadata(db),
        },
      };
    }
    if (request.task.kind === 'snapshot-export') {
      const { repoId } = request.task;
      // A graph built under other repository ids, such as an older CLI's
      // root id, has nothing to export for this one.
      if (!store.listRepositories().some((row) => row.repoId === repoId))
        return { ok: true, result: { kind: 'snapshot-export', value: null } };
      const { envelope } = await buildCodeGraphSnapshot({
        store,
        repoId: request.task.repoId,
        generatedAt: request.task.generatedAt,
      });
      return {
        ok: true,
        result: { kind: 'snapshot-export', value: envelope },
      };
    }
    if (request.task.kind === 'calls') {
      return {
        ok: true,
        result: {
          kind: 'calls',
          value: request.task.calls.map((call) =>
            call.method === 'status'
              ? readCodeGraphSummaryProjection(request.dbPath)
              : executeCall(call, queries),
          ),
        },
      };
    }
    const lastBuildAt = readLastBuildAt(db);
    if (request.task.kind === 'detect-changed') {
      const changes = await getDiffRanges(
        request.task.rootPath,
        request.task.baseRef,
      );
      const mapped = mapRangesToSymbols({
        store,
        repoId: request.task.repoId,
        changes,
      });
      return {
        ok: true,
        result: {
          kind: 'detect-changed',
          value: { ...mapped, lastBuildAt },
        },
      };
    }
    const report = await assembleChangeImpact({
      store,
      queries,
      repoId: request.task.repoId,
      rootPath: request.task.rootPath,
      baseRef: request.task.baseRef,
      resourcesDir: request.task.resourcesDir,
      cachePath: path.join(path.dirname(request.dbPath), 'before-cache.db'),
      ...(request.task.maxDepth === undefined
        ? {}
        : { maxDepth: request.task.maxDepth }),
    });
    return {
      ok: true,
      result: {
        kind: 'change-impact',
        value: { report, lastBuildAt },
      },
    };
  } catch (error) {
    failed = true;
    return {
      ok: false,
      code:
        error instanceof CodeGraphWriterLeaseBusyError ||
        classifyCodeGraphReadDatabaseError(error) === 'busy'
          ? 'busy'
          : 'database-error',
      message: 'The retained Code Graph could not be read. Try again.',
    };
  } finally {
    release?.(failed);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkerRequest(value: unknown): value is CodeGraphWorkerReadRequest {
  return (
    isRecord(value) &&
    typeof value.dbPath === 'string' &&
    isRecord(value.task) &&
    typeof value.task.kind === 'string'
  );
}

/** The slice of a host channel the serving loop uses. */
export interface CodeGraphReadWorkerPort {
  on(event: 'message', listener: (event: unknown) => void): unknown;
  postMessage(message: unknown): void;
}

async function respond(
  port: CodeGraphReadWorkerPort,
  payload: unknown,
  connections: CodeGraphReadConnectionCache,
): Promise<void> {
  const response = isWorkerRequest(payload)
    ? await executeCodeGraphRead(payload, connections)
    : {
        ok: false as const,
        code: 'invalid-response' as const,
        message: 'Invalid Code Graph read request.',
      };
  try {
    port.postMessage(response);
  } catch {
    // The runner waits for this answer; exiting lets it see the failure now
    // instead of at its watchdog.
    process.exit(1);
  }
}

/**
 * Serves read requests until the runner kills this process (idle timeout,
 * eviction, cancellation, watchdog or app shutdown). Requests run strictly one
 * at a time in arrival order, on the worker's kept connection when it is still
 * valid (`CodeGraphReadConnectionCache`).
 */
export function serveCodeGraphReads(port: CodeGraphReadWorkerPort): void {
  const connections = new CodeGraphReadConnectionCache();
  let previous: Promise<void> = Promise.resolve();
  port.on('message', (event: unknown): void => {
    const payload = isRecord(event) && 'data' in event ? event.data : undefined;
    previous = previous
      .then(() => respond(port, payload, connections))
      .catch(() => {
        // Unreachable in practice (`executeCodeGraphRead` answers every
        // failure), but a request must never go unanswered by a live worker.
        process.exit(1);
      });
  });
}
