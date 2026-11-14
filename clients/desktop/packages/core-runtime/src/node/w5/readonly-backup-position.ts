import type { Stats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { W5BackupPosition } from './commit-log/commit-log';
import { readW5BackupPosition } from './commit-log/backup-position';
import { W5_COMMIT_LOG_SCHEMA_VERSION } from './commit-log/schema-version';
import { W5CommitLogError, W5CommitRefusedError } from './commit-log/errors';
import {
  w5RootEvidenceScope,
  requireW5RootEvidenceScope,
  sameW5RootEvidenceScope,
  type W5RootEvidenceScope,
} from './service-history';
import { isErrnoException } from './maintenance-guards';
import type { W5BackupReadContext } from './backup';

interface CaptureState {
  scope?: W5RootEvidenceScope;
  readonly directories: Map<string, Stats>;
}

async function noEarlierLogArtifacts(
  root: string,
  capture?: CaptureState,
): Promise<void> {
  const w5 = join(root, 'w5');
  for (const [path, identity] of capture?.directories ?? [])
    await requireDirectoryIdentity(path, identity);
  let entries;
  try {
    entries = await readdir(w5, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (
      entry.name !== 'backups' ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    )
      throw new W5CommitLogError(
        'STORAGE_UNAVAILABLE',
        'W5 history exists without its log.',
      );
    for (const backup of await readdir(join(w5, 'backups'), {
      withFileTypes: true,
    })) {
      const path = join(w5, 'backups', backup.name);
      const created = capture?.directories.get(path);
      if (
        !backup.isDirectory() ||
        backup.isSymbolicLink() ||
        (!created && (await readdir(path)).length !== 0)
      )
        throw new W5CommitLogError(
          'STORAGE_UNAVAILABLE',
          'W5 history exists without its log.',
        );
      if (created) await requireDirectoryIdentity(path, created);
    }
  }
}
async function directoryIdentity(path: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new W5CommitLogError(
        'STORAGE_UNAVAILABLE',
        'Unsafe W5 backup directory.',
      );
    return stat;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function requireDirectoryIdentity(
  path: string,
  before: Stats | undefined,
): Promise<void> {
  const after = await directoryIdentity(path);
  if (before?.dev !== after?.dev || before?.ino !== after?.ino)
    throw new W5CommitLogError(
      'STORAGE_UNAVAILABLE',
      'W5 backup directory changed.',
    );
}
/** Cold backup read only. Never creates, migrates or recovers a canonical log. */
export async function readOnlyW5BackupPosition(
  dataRoot: string,
): Promise<W5BackupPosition> {
  return readPosition(dataRoot);
}

/** Only directories made by this live capture context may gain backup files. */
export function createReadOnlyW5BackupContext(
  dataRoot: string,
): W5BackupReadContext {
  const capture: CaptureState = { directories: new Map() };
  return {
    dataRoot,
    host: {
      snapshot: (): Promise<W5BackupPosition> =>
        readPosition(dataRoot, capture),
    },
    captureCreated: async (directory: string): Promise<void> => {
      const scope = capture.scope;
      if (!scope) return;
      const suppliedPath = resolve(directory);
      // Resolve root aliases without following a symlink at the backup itself.
      const path = join(
        await realpath(dirname(suppliedPath)),
        basename(suppliedPath),
      );
      if (dirname(path) !== join(scope.canonicalDataRoot, 'w5', 'backups'))
        throw new W5CommitLogError(
          'STORAGE_UNAVAILABLE',
          'Unsafe W5 backup directory.',
        );
      await requireW5RootEvidenceScope(scope);
      await noEarlierLogArtifacts(scope.canonicalDataRoot, capture);
      const identity = await directoryIdentity(suppliedPath);
      if (!identity || (await readdir(path)).length !== 0)
        throw new W5CommitLogError(
          'STORAGE_UNAVAILABLE',
          'Unsafe W5 backup directory.',
        );
      await requireDirectoryIdentity(path, identity);
      await requireW5RootEvidenceScope(scope);
      capture.directories.set(path, identity);
    },
  };
}

async function readPosition(
  dataRoot: string,
  capture?: CaptureState,
): Promise<W5BackupPosition> {
  if (capture?.scope) await requireW5RootEvidenceScope(capture.scope);
  const scope = await w5RootEvidenceScope(dataRoot);
  if (capture?.scope && !sameW5RootEvidenceScope(scope, capture.scope))
    throw new W5CommitLogError(
      'STORAGE_UNAVAILABLE',
      'W5 backup root changed.',
    );
  const directory = join(scope.canonicalDataRoot, 'w5');
  const parent = await directoryIdentity(directory);
  const path = join(directory, 'commit-log.sqlite');
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    await noEarlierLogArtifacts(scope.canonicalDataRoot, capture);
    await requireDirectoryIdentity(directory, parent);
    await requireW5RootEvidenceScope(scope);
    if (capture) capture.scope = scope;
    return {
      commitId: 0,
      schemaVersion: W5_COMMIT_LOG_SCHEMA_VERSION,
      revisions: {},
    };
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new W5CommitLogError('STORAGE_UNAVAILABLE', 'Unsafe W5 backup log.');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('BEGIN');
    const position = readW5BackupPosition(db);
    if (
      position.schemaVersion < 1 ||
      position.schemaVersion > W5_COMMIT_LOG_SCHEMA_VERSION
    )
      throw new W5CommitLogError(
        'UNSUPPORTED_SCHEMA',
        'Unsupported W5 backup log.',
      );
    const after = await lstat(path);
    await requireDirectoryIdentity(directory, parent);
    await requireW5RootEvidenceScope(scope);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1
    )
      throw new W5CommitLogError(
        'STORAGE_UNAVAILABLE',
        'W5 backup log changed.',
      );
    return position;
  } catch (error) {
    if (
      error instanceof W5CommitLogError ||
      error instanceof W5CommitRefusedError
    )
      throw error;
    const code: unknown =
      typeof error === 'object' && error !== null && 'errcode' in error
        ? error.errcode
        : undefined;
    throw new W5CommitLogError(
      code === 5 || code === 6 ? 'WRITER_UNAVAILABLE' : 'STORAGE_UNAVAILABLE',
      'W5 backup log is unavailable.',
      error,
    );
  } finally {
    db?.close();
  }
}
