import { createHash } from 'node:crypto';
import {
  lstat,
  readdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  W5_COMMIT_LOG_SCHEMA_VERSION,
  openW5CommitLogDatabase,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { readW5FileBytes, validateW5Document } from './w5-backup';
import { isErrnoException, isRecord } from './type-guards';
import { validateId } from './validation';

export interface W5FileIssue {
  readonly path: string;
  /** Observed opaque artifacts, distinct from unknown owned-state evidence. */
  readonly artifactKind?:
    | 'unrecognized-workspace-file'
    | 'unindexed-workspace-directory'
    | 'unrecognized-w5-file';
  readonly reason:
    | 'corrupt-file'
    | 'missing-file'
    | 'unknown-artifact'
    | 'log-mismatch'
    | 'untracked-file'
    /** An unreadable lifecycle journal entry the user moved aside (CAN-5335). */
    | 'quarantined-journal';
}
export type W5DiagnosisScope = 'all-artifacts' | 'w5-owned';

export interface W5Diagnosis {
  readonly files: readonly W5FileIssue[];
  /** Filename-matching regular files, not operations; null if inspection is unavailable. */
  readonly destructiveJournalArtifactCount: number | null;
  readonly logIssue: 'unavailable' | 'incompatible-schema' | null;
  /** Proven by running the existing schema upgrader on a disposable copy only. */
  readonly schemaUpgrade?: { readonly from: number; readonly to: number };
  /** Commits not yet applied, oldest first. */
  readonly commits: readonly {
    readonly commitId: number;
    readonly operation: string;
    readonly state: string;
    readonly diagnostics: string | null;
    readonly paths?: readonly string[];
    /** Operations of the receipts (keys) the commit holds; abandoning it releases them. */
    readonly receiptOperations: readonly string[];
  }[];
  /** Each reservation's operation and state (A24): resolve decisions key on both. */
  readonly reservations: readonly {
    readonly reservationId: string;
    readonly operation: string;
    readonly state: string;
    readonly diagnostics: string;
  }[];
}

function validId(id: string): boolean {
  try {
    validateId(id, 'workspace directory');
    return true;
  } catch {
    return false;
  }
}

interface DiagnosticCopy {
  readonly db: DatabaseSync;
  readonly schemaUpgrade?: W5Diagnosis['schemaUpgrade'];
  close(): Promise<void>;
}

async function countDestructiveJournalArtifacts(
  w5Root: string,
  issues: W5FileIssue[],
): Promise<number | null> {
  const path = 'w5/destructive-lifecycles';
  const directory = join(w5Root, 'destructive-lifecycles');
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      issues.push({ path, reason: 'unknown-artifact' });
      return null;
    }
    let count = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        /^([a-f0-9]{64}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\.json$/.test(
          entry.name,
        )
      )
        count += 1;
      else
        issues.push({
          path: `${path}/${entry.name}`,
          reason: 'unknown-artifact',
        });
    }
    return count;
  } catch {
    issues.push({ path, reason: 'corrupt-file' });
    return null;
  }
}

/** No journal scanner reads these; each is user-moved evidence, never deleted. */
async function reportQuarantinedJournals(
  w5Root: string,
  issues: W5FileIssue[],
): Promise<void> {
  const path = 'w5/quarantined-lifecycles';
  try {
    const stat = await lstat(join(w5Root, 'quarantined-lifecycles'));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      issues.push({ path, reason: 'unknown-artifact' });
      return;
    }
    for (const entry of await readdir(join(w5Root, 'quarantined-lifecycles')))
      issues.push({ path: `${path}/${entry}`, reason: 'quarantined-journal' });
  } catch {
    issues.push({ path, reason: 'corrupt-file' });
  }
}

async function copyLogForDiagnosis(
  logPath: string,
  upgradeSchemaCopy: boolean,
): Promise<DiagnosticCopy> {
  // SQLite readOnly can create/change source WAL/SHM files. Inspect a private
  // copy, including WAL, so even interrupted decisions are visible without
  // touching source bytes. Never copy the SHM index; SQLite rebuilds it here.
  const temporary = await mkdtemp(join(tmpdir(), 'canopy-w5-diagnose-'));
  try {
    const copied = new Map<string, Buffer>();
    for (const suffix of ['', '-wal', '-journal']) {
      try {
        const bytes = await readFile(`${logPath}${suffix}`);
        copied.set(suffix, bytes);
        await writeFile(join(temporary, `commit-log.sqlite${suffix}`), bytes, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (
          suffix === '' ||
          !isErrnoException(error) ||
          error.code !== 'ENOENT'
        )
          throw error;
      }
    }
    for (const [suffix, bytes] of Array.from(copied))
      if (!(await readFile(`${logPath}${suffix}`)).equals(bytes))
        throw new Error('Log changed during inspection');
    for (const suffix of ['-wal', '-journal']) {
      if (copied.has(suffix)) continue;
      try {
        await lstat(`${logPath}${suffix}`);
        throw new Error('SQLite sidecar appeared during inspection');
      } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
      }
    }
    const copiedPath = join(temporary, 'commit-log.sqlite');
    let db = new DatabaseSync(copiedPath, { readOnly: true });
    let schemaUpgrade: W5Diagnosis['schemaUpgrade'];
    try {
      const version = db
        .prepare("SELECT value FROM w5_meta WHERE key = 'schema_version'")
        .get()?.value;
      if (
        upgradeSchemaCopy &&
        (version === '1' || version === '2' || version === '3')
      ) {
        db.close();
        db = openW5CommitLogDatabase(copiedPath);
        schemaUpgrade = {
          from: Number(version),
          to: W5_COMMIT_LOG_SCHEMA_VERSION,
        };
      }
    } catch (error) {
      if (db.isOpen) db.close();
      throw error;
    }
    return {
      db,
      ...(schemaUpgrade ? { schemaUpgrade } : {}),
      close: async (): Promise<void> => {
        try {
          db.close();
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Offline-only reader: does not open W5CommitLog or its auto-recovering host.
 * No source migration, recovery, compensation, reservation transition or write.
 * Internal-root callers may preview schema upgrades and abandoned file history
 * on the disposable copy; commit rows remain visible for opt-in validation.
 * Kept outside the running desktop graph; production exposure remains blocked.
 */
export async function diagnoseW5State(
  dataRoot: string,
  scope: W5DiagnosisScope = 'all-artifacts',
  upgradeSchemaCopy = false,
  previewAbandonCommits: readonly number[] = [],
): Promise<W5Diagnosis> {
  const root = join(dataRoot, 'workspaces');
  const issues: W5FileIssue[] = [];
  const images = new Map<string, Buffer | null>();
  const documents = new Map<string, Record<string, unknown>>();
  async function inspect(path: string, required: boolean): Promise<void> {
    try {
      const bytes = await readW5FileBytes(root, path);
      images.set(path, bytes);
      if (bytes === null) {
        if (required) issues.push({ path, reason: 'missing-file' });
      } else {
        documents.set(path, validateW5Document(bytes, path));
      }
    } catch {
      issues.push({ path, reason: 'corrupt-file' });
    }
  }
  await inspect('index.json', true);
  await inspect('index.json.bak', false);
  const workspaceTypes = new Map<string, unknown>();
  const rows = documents.get('index.json')?.workspaces;
  if (Array.isArray(rows))
    for (const row of rows)
      if (isRecord(row) && typeof row.id === 'string')
        workspaceTypes.set(row.id, row.type);
  const ids = new Set(workspaceTypes.keys());
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid W5 root');
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && validId(entry.name)) {
        ids.add(entry.name);
        if (!workspaceTypes.has(entry.name))
          issues.push({
            path: entry.name,
            reason: 'unknown-artifact',
            artifactKind: 'unindexed-workspace-directory',
          });
        // Workspace payloads are cloned, not owned or interpreted by W5.
        if (scope === 'all-artifacts')
          for (const child of await readdir(join(root, entry.name), {
            withFileTypes: true,
          }))
            if (
              child.name !== 'workspace.json' &&
              child.name !== 'worktrees.json'
            )
              issues.push({
                path: `${entry.name}/${child.name}`,
                reason: 'unknown-artifact',
              });
      } else if (
        entry.name !== 'index.json' &&
        entry.name !== 'index.json.bak'
      ) {
        issues.push({
          path: entry.name,
          reason: 'unknown-artifact',
          ...(entry.isDirectory()
            ? { artifactKind: 'unindexed-workspace-directory' as const }
            : entry.isFile()
              ? { artifactKind: 'unrecognized-workspace-file' as const }
              : {}),
        });
      }
    }
  } catch {
    issues.push({ path: '.', reason: 'corrupt-file' });
  }
  for (const id of Array.from(ids).sort()) {
    await inspect(`${id}/workspace.json`, workspaceTypes.has(id));
    const type = workspaceTypes.get(id);
    await inspect(
      `${id}/worktrees.json`,
      type === 'single-repo' || type === 'multi-repo',
    );
  }

  let logIssue: W5Diagnosis['logIssue'] = null;
  let destructiveJournalArtifactCount: number | null = null;
  const commits: Array<W5Diagnosis['commits'][number]> = [];
  const reservations: Array<W5Diagnosis['reservations'][number]> = [];
  let copy: DiagnosticCopy | undefined;
  try {
    // Check the complete parent chain, including sidecars, before SQLite opens.
    for (const path of [dataRoot, join(dataRoot, 'w5')]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Invalid log parent');
    }
    const recognizedLogArtifacts = new Set([
      'commit-log.sqlite',
      'commit-log.sqlite-wal',
      'commit-log.sqlite-shm',
      'commit-log.sqlite-journal',
      'backups',
      'restore-evidence',
    ]);
    const logArtifacts = await readdir(join(dataRoot, 'w5'), {
      withFileTypes: true,
    });
    destructiveJournalArtifactCount = 0;
    for (const entry of logArtifacts)
      if (entry.name === 'destructive-lifecycles')
        destructiveJournalArtifactCount =
          await countDestructiveJournalArtifacts(join(dataRoot, 'w5'), issues);
      else if (entry.name === 'quarantined-lifecycles')
        await reportQuarantinedJournals(join(dataRoot, 'w5'), issues);
      else if (
        !recognizedLogArtifacts.has(entry.name) ||
        entry.isSymbolicLink()
      )
        issues.push({
          path: `w5/${entry.name}`,
          reason: 'unknown-artifact',
          ...(!recognizedLogArtifacts.has(entry.name) && entry.isFile()
            ? { artifactKind: 'unrecognized-w5-file' as const }
            : {}),
        });
    const logPath = join(dataRoot, 'w5/commit-log.sqlite');
    for (const path of [
      logPath,
      `${logPath}-wal`,
      `${logPath}-shm`,
      `${logPath}-journal`,
    ]) {
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('Invalid log file');
      } catch (error) {
        if (
          path === logPath ||
          !isErrnoException(error) ||
          error.code !== 'ENOENT'
        )
          throw error;
      }
    }
    copy = await copyLogForDiagnosis(logPath, upgradeSchemaCopy);
    const { db } = copy;
    db.exec('PRAGMA query_only = ON; BEGIN');
    const version = db
      .prepare("SELECT value FROM w5_meta WHERE key = 'schema_version'")
      .get()?.value;
    if (version !== String(W5_COMMIT_LOG_SCHEMA_VERSION)) {
      logIssue = 'incompatible-schema';
    } else {
      const receipts = db.prepare(
        'SELECT operation FROM w5_receipts WHERE commit_id = ? ORDER BY operation',
      );
      for (const row of db
        .prepare(
          "SELECT commit_id, operation, state, diagnostics_json FROM w5_commits WHERE state != 'applied' ORDER BY commit_id",
        )
        .all()) {
        if (
          typeof row.commit_id !== 'number' ||
          typeof row.operation !== 'string' ||
          typeof row.state !== 'string' ||
          (row.diagnostics_json !== null &&
            typeof row.diagnostics_json !== 'string')
        )
          throw new Error('Invalid commit');
        const receiptOperations = receipts
          .all(row.commit_id)
          .map(({ operation }) => {
            if (typeof operation !== 'string')
              throw new Error('Invalid receipt');
            return operation;
          });
        commits.push({
          commitId: row.commit_id,
          operation: row.operation,
          state: row.state,
          diagnostics: row.diagnostics_json,
          paths: db
            .prepare(
              'SELECT path FROM w5_commit_files WHERE commit_id = ? ORDER BY path',
            )
            .all(row.commit_id)
            .map(({ path }) => {
              if (typeof path !== 'string')
                throw new Error('Invalid commit path');
              return path;
            }),
          receiptOperations,
        });
      }
      for (const row of db
        .prepare(
          'SELECT reservation_id, operation, state, diagnostics_json FROM w5_reservations ORDER BY reservation_id',
        )
        .all()) {
        if (
          typeof row.reservation_id !== 'string' ||
          typeof row.operation !== 'string' ||
          typeof row.state !== 'string' ||
          typeof row.diagnostics_json !== 'string'
        )
          throw new Error('Invalid reservation');
        reservations.push({
          reservationId: row.reservation_id,
          operation: row.operation,
          state: row.state,
          diagnostics: row.diagnostics_json,
        });
      }
      const tracked = new Set<string>();
      for (const row of db
        .prepare(
          `SELECT f.path, f.new_fingerprint FROM w5_commit_files f
        WHERE f.commit_id = (
          SELECT MAX(last.commit_id) FROM w5_commit_files last
          WHERE last.path = f.path AND last.commit_id NOT IN (SELECT value FROM json_each(?))
        )
        ORDER BY f.path`,
        )
        .all(JSON.stringify(previewAbandonCommits))) {
        if (
          typeof row.path !== 'string' ||
          (row.new_fingerprint !== null &&
            typeof row.new_fingerprint !== 'string')
        )
          throw new Error('Invalid file receipt');
        const path = relative(root, row.path).split('\\').join('/');
        // Never inspect a path supplied by the log outside the three namespaces.
        if (
          join(root, path) !== row.path ||
          !/^(index\.json(?:\.bak)?|[a-zA-Z0-9_-]+\/(workspace|worktrees)\.json)$/.test(
            path,
          )
        ) {
          issues.push({ path: 'commit-log', reason: 'unknown-artifact' });
          continue;
        }
        tracked.add(path);
        if (!images.has(path)) await inspect(path, false);
        const bytes = images.get(path);
        if (bytes === undefined) continue; // Already reported unreadable/non-file.
        const fingerprint =
          bytes === null
            ? null
            : createHash('sha256').update(bytes).digest('hex');
        if (fingerprint !== row.new_fingerprint)
          issues.push({ path, reason: 'log-mismatch' });
      }
      for (const [path, bytes] of Array.from(images))
        if (bytes !== null && !tracked.has(path))
          issues.push({ path, reason: 'untracked-file' });
    }
  } catch {
    logIssue = 'unavailable';
  } finally {
    await copy?.close();
  }

  return {
    files: issues.sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason),
    ),
    logIssue,
    ...(copy?.schemaUpgrade ? { schemaUpgrade: copy.schemaUpgrade } : {}),
    destructiveJournalArtifactCount,
    commits,
    reservations,
  };
}

/** Lossless rows removed by W5 abandon, read from the same disposable-copy reader. */
export async function readW5CommitAbandonmentEvidence(
  dataRoot: string,
  commitIds: readonly number[],
): Promise<string> {
  const copy = await copyLogForDiagnosis(
    join(dataRoot, 'w5/commit-log.sqlite'),
    false,
  );
  try {
    const commits = commitIds.map((commitId) => {
      const commit = copy.db
        .prepare('SELECT * FROM w5_commits WHERE commit_id = ?')
        .get(commitId);
      if (commit?.state !== 'recovery-required')
        throw new Error(`Commit ${commitId} is not recovery-required`);
      return {
        commit,
        files: copy.db
          .prepare(
            'SELECT * FROM w5_commit_files WHERE commit_id = ? ORDER BY path',
          )
          .all(commitId),
        receipts: copy.db
          .prepare('SELECT * FROM w5_receipts WHERE commit_id = ?')
          .all(commitId),
      };
    });
    return JSON.stringify(
      { version: 1, source: dataRoot, commits },
      (_key, value: unknown) =>
        value instanceof Uint8Array
          ? { base64: Buffer.from(value).toString('base64') }
          : value,
    );
  } finally {
    await copy.close();
  }
}
