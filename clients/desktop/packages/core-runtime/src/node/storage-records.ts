import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';

import {
  createNamespaceBackupRecord,
  validateNamespaceBackupRecord,
  type NamespaceBackupRecord,
} from '../storage/backup-record';
import {
  StorageRowOwnerError,
  backupRecordReference,
  decideRowWrite,
  namespaceBackupRecordPath,
  ownerFlipRecordErrors,
  ownerFlipRecordPath,
  parseOwnerFlipRecord,
  type OwnerFlipRecord,
  type OwnerFlipRecordRead,
} from '../storage/owner-records';
import { STORAGE_OWNERSHIP } from '../storage/storage-ownership.generated';
import type {
  StorageOwnershipRow,
  StorageTransitionOwner,
  StorageWriterPrincipal,
} from '../storage/writer-authority';

/*
 * The owner records of a storage row on disk (CAN-7690). Readers run in
 * every writer of a row before it writes. The two writers are dormant: the
 * activation that moves a row and the restore that returns it call them.
 */

function hostPath(dataRoot: string, relative: string): string {
  return join(dataRoot, ...relative.split(posix.sep));
}

/** The host path of a row's owner_flip record under `dataRoot`. */
export function ownerFlipRecordFile(
  dataRoot: string,
  namespaceId: string,
): string {
  return hostPath(dataRoot, ownerFlipRecordPath(namespaceId));
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object'
    ? Reflect.get(error, 'code')
    : undefined;
}

/** A row's owner record; a missing file is `absent`, anything else fails closed. */
export async function readOwnerFlipRecord(
  dataRoot: string,
  namespaceId: string,
): Promise<OwnerFlipRecordRead> {
  let text: string;
  try {
    text = await readFile(ownerFlipRecordFile(dataRoot, namespaceId), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'unreadable',
      reason: `The owner record could not be read (${String(errorCode(error))}).`,
    };
  }
  return parseOwnerFlipRecord(text, namespaceId);
}

/**
 * Refuses, before any byte is written, a write by `writer` to a row whose
 * owner record names another owner or can't be read. The one check every
 * writer of a row that moves runs, the daemon's included.
 */
export async function assertRowWritable(
  dataRoot: string,
  namespaceId: string,
  writer: StorageWriterPrincipal,
): Promise<void> {
  const decision = decideRowWrite(
    await readOwnerFlipRecord(dataRoot, namespaceId),
    writer,
  );
  if (!decision.allowed) throw new StorageRowOwnerError(namespaceId, decision);
}

export type OwnerRecordWriteErrorCode =
  | 'BACKUP_RECORD_INVALID'
  | 'BACKUP_RECORD_MISSING'
  | 'FLUSH_UNCONFIRMED'
  | 'OWNER_RECORD_INVALID';

export class OwnerRecordWriteError extends Error {
  public readonly code: OwnerRecordWriteErrorCode;

  public constructor(code: OwnerRecordWriteErrorCode, message: string) {
    super(message);
    this.name = 'OwnerRecordWriteError';
    this.code = code;
  }
}

export interface OwnerRecordWriteOptions {
  /** The host's folder flush: its secure-files port's `syncDirectory`. */
  readonly syncDirectory: (path: string) => Promise<'flushed' | 'unsupported'>;
  /** Trusted host proof that a path is outside every checkout. */
  readonly isOutsideCheckouts: (dataRootRelativePath: string) => boolean;
  /** The ownership rows records are checked against. */
  readonly ownership?: readonly StorageOwnershipRow[];
}

/**
 * Installs `text` at `path` under `dataRoot` atomically and durably,
 * creating its folder. Every folder from the record's up to the data root is
 * flushed into its parent each time, created by this call or not, so a crash
 * can't lose the record with its folder, even after an earlier call failed
 * before its own flushes.
 */
async function installDurably(
  dataRoot: string,
  path: string,
  text: string,
  syncDirectory: OwnerRecordWriteOptions['syncDirectory'],
): Promise<void> {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const flush = async (at: string): Promise<void> => {
    if ((await syncDirectory(at)) !== 'flushed')
      throw new OwnerRecordWriteError('FLUSH_UNCONFIRMED', 'Not flushed.');
  };
  await flush(folder);
  const root = resolve(dataRoot);
  for (
    let at = resolve(folder);
    at !== root && at !== dirname(at);
    at = dirname(at)
  )
    await flush(dirname(at));
}

/**
 * Keeps a row's verified backup record at its fixed path, so an owner_flip
 * record can cite it. Dormant: the activation that moves a row calls it.
 */
export async function persistNamespaceBackupRecord(
  dataRoot: string,
  record: NamespaceBackupRecord,
  options: OwnerRecordWriteOptions,
): Promise<void> {
  const verified = createNamespaceBackupRecord(record, {
    rows: options.ownership ?? STORAGE_OWNERSHIP,
    isOutsideCheckouts: options.isOutsideCheckouts,
  });
  await installDurably(
    dataRoot,
    hostPath(dataRoot, namespaceBackupRecordPath(verified.namespaceId)),
    `${JSON.stringify(verified, null, 2)}\n`,
    options.syncDirectory,
  );
}

export interface OwnerFlipInput {
  readonly namespaceId: string;
  readonly fromOwner: StorageTransitionOwner;
  readonly toOwner: StorageTransitionOwner;
  readonly workPackage: string;
  /** The verifiedBy digest of the backup record this change was gated on. */
  readonly backupDigest: string;
  readonly flippedAt: string;
}

async function persistedBackup(
  dataRoot: string,
  namespaceId: string,
  options: OwnerRecordWriteOptions,
): Promise<NamespaceBackupRecord> {
  let text: string;
  try {
    text = await readFile(
      hostPath(dataRoot, namespaceBackupRecordPath(namespaceId)),
      'utf8',
    );
  } catch {
    throw new OwnerRecordWriteError(
      'BACKUP_RECORD_MISSING',
      `${namespaceId} has no verified backup record.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const result = validateNamespaceBackupRecord(value, {
    rows: options.ownership ?? STORAGE_OWNERSHIP,
    isOutsideCheckouts: options.isOutsideCheckouts,
  });
  if (!result.ok || result.record.namespaceId !== namespaceId)
    throw new OwnerRecordWriteError(
      'BACKUP_RECORD_INVALID',
      `${namespaceId}'s backup record is not valid.`,
    );
  return result.record;
}

/**
 * Records a row's new owner, citing the verified backup record it was gated
 * on. Refuses, writing nothing, unless that row's persisted backup record is
 * valid and is the one `backupDigest` names. Dormant: the activation that
 * moves a row and the restore that returns it call it.
 */
export async function writeOwnerFlipRecord(
  dataRoot: string,
  input: OwnerFlipInput,
  options: OwnerRecordWriteOptions,
): Promise<OwnerFlipRecord> {
  const backup = await persistedBackup(dataRoot, input.namespaceId, options);
  if (backup.verifiedBy.digest !== input.backupDigest)
    throw new OwnerRecordWriteError(
      'BACKUP_RECORD_INVALID',
      `${input.namespaceId}'s backup record is not the one this change cites.`,
    );
  const record: OwnerFlipRecord = {
    namespaceId: input.namespaceId,
    fromOwner: input.fromOwner,
    toOwner: input.toOwner,
    workPackage: input.workPackage,
    backupRecord: backupRecordReference(input.namespaceId, input.backupDigest),
    flippedAt: input.flippedAt,
  };
  const errors = ownerFlipRecordErrors(record, input.namespaceId);
  if (errors.length > 0)
    throw new OwnerRecordWriteError('OWNER_RECORD_INVALID', errors.join('; '));
  await installDurably(
    dataRoot,
    hostPath(dataRoot, ownerFlipRecordPath(input.namespaceId)),
    `${JSON.stringify(record, null, 2)}\n`,
    options.syncDirectory,
  );
  return Object.freeze(record);
}
