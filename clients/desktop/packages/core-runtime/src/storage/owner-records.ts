import type {
  StorageTransitionOwner,
  StorageWriterPrincipal,
} from './writer-authority';

/*
 * The owner records of a storage row (CAN-7690, CAN-5340): its last verified
 * backup record and its owner_flip record, at fixed data-root-relative paths
 * every build can find. A writer of a row whose owner has changed refuses
 * before writing a byte. With no record, the compiled ownership table
 * decides, as before.
 */

/** Data-root-relative folder holding one row's records. */
export function storageRecordsFolder(namespaceId: string): string {
  return `storage-records/${namespaceId}`;
}

/** Data-root-relative path of a row's owner_flip record. */
export function ownerFlipRecordPath(namespaceId: string): string {
  return `${storageRecordsFolder(namespaceId)}/owner-flip.json`;
}

/** Data-root-relative path of a row's last verified backup record. */
export function namespaceBackupRecordPath(namespaceId: string): string {
  return `${storageRecordsFolder(namespaceId)}/namespace-backup.json`;
}

const OWNERS: readonly StorageTransitionOwner[] = [
  'legacy',
  'daemon',
  'offline',
  'interface-local',
];
const WORK_PACKAGE = /^W[1-7]$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** The transition-owner change of one row (storage-backup-restore.schema.yaml). */
export interface OwnerFlipRecord {
  readonly namespaceId: string;
  readonly fromOwner: StorageTransitionOwner;
  readonly toOwner: StorageTransitionOwner;
  readonly workPackage: string;
  /** `<namespace-backup path>#sha256:<digest>` of the backup it was gated on. */
  readonly backupRecord: string;
  readonly flippedAt: string;
}

export type OwnerFlipRecordRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'record'; readonly record: OwnerFlipRecord }
  | { readonly kind: 'unreadable'; readonly reason: string };

function isFields(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOwner(value: unknown): value is StorageTransitionOwner {
  return OWNERS.some((owner) => owner === value);
}

/** The backupRecord reference an owner_flip record makes to a backup. */
export function backupRecordReference(
  namespaceId: string,
  digest: string,
): string {
  return `${namespaceBackupRecordPath(namespaceId)}#sha256:${digest}`;
}

/**
 * Checks an owner_flip record for `namespaceId`. Errors name the first
 * field that is wrong; an empty list means the record is valid.
 */
export function ownerFlipRecordErrors(
  candidate: unknown,
  namespaceId: string,
): readonly string[] {
  if (!isFields(candidate)) return ['owner_flip must be an object'];
  const errors: string[] = [];
  if (candidate.namespaceId !== namespaceId)
    errors.push(`namespaceId must be ${namespaceId}`);
  if (!isOwner(candidate.fromOwner)) errors.push('fromOwner is not an owner');
  if (!isOwner(candidate.toOwner)) errors.push('toOwner is not an owner');
  if (candidate.fromOwner === candidate.toOwner)
    errors.push('fromOwner and toOwner must differ');
  if (
    typeof candidate.workPackage !== 'string' ||
    !WORK_PACKAGE.test(candidate.workPackage)
  )
    errors.push('workPackage must be W1 to W7');
  const prefix = `${namespaceBackupRecordPath(namespaceId)}#sha256:`;
  if (
    typeof candidate.backupRecord !== 'string' ||
    !candidate.backupRecord.startsWith(prefix) ||
    !DIGEST.test(candidate.backupRecord.slice(prefix.length))
  )
    errors.push(`backupRecord must be ${prefix}<sha256>`);
  if (
    typeof candidate.flippedAt !== 'string' ||
    !DATE_TIME.test(candidate.flippedAt) ||
    !Number.isFinite(Date.parse(candidate.flippedAt))
  )
    errors.push('flippedAt must be an RFC 3339 date-time with a time zone');
  return errors;
}

/** Reads the text of a row's owner_flip file; `null` text means no file. */
export function parseOwnerFlipRecord(
  text: string | null,
  namespaceId: string,
): OwnerFlipRecordRead {
  if (text === null) return { kind: 'absent' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', reason: 'The owner record is not JSON.' };
  }
  const errors = ownerFlipRecordErrors(value, namespaceId);
  if (errors.length > 0 || !isFields(value))
    return { kind: 'unreadable', reason: errors.join('; ') };
  const { fromOwner, toOwner, workPackage, backupRecord, flippedAt } = value;
  if (
    !isOwner(fromOwner) ||
    !isOwner(toOwner) ||
    typeof workPackage !== 'string' ||
    typeof backupRecord !== 'string' ||
    typeof flippedAt !== 'string'
  )
    return { kind: 'unreadable', reason: 'The owner record is incomplete.' };
  return {
    kind: 'record',
    record: Object.freeze({
      namespaceId,
      fromOwner,
      toOwner,
      workPackage,
      backupRecord,
      flippedAt,
    }),
  };
}

/** The transition owner a writer principal writes as. */
export function ownerOfWriter(
  writer: StorageWriterPrincipal,
): StorageTransitionOwner {
  return writer === 'daemon' ? 'daemon' : 'legacy';
}

export type RowWriteDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'owned_elsewhere' | 'record_unreadable';
      /** The owner that holds the row, when its record is readable. */
      readonly owner?: StorageTransitionOwner;
      readonly message: string;
    };

/**
 * Whether `writer` may write a row, given its owner record. No record: the
 * compiled ownership table decides, as before. A record: only its toOwner
 * writes. An unreadable record: nobody writes (fail closed).
 */
export function decideRowWrite(
  read: OwnerFlipRecordRead,
  writer: StorageWriterPrincipal,
): RowWriteDecision {
  if (read.kind === 'absent') return { allowed: true };
  if (read.kind === 'unreadable')
    return {
      allowed: false,
      reason: 'record_unreadable',
      message:
        'The record of who keeps this data can’t be read, so nothing was saved.',
    };
  if (read.record.toOwner === ownerOfWriter(writer)) return { allowed: true };
  return {
    allowed: false,
    reason: 'owned_elsewhere',
    owner: read.record.toOwner,
    message:
      read.record.toOwner === 'daemon'
        ? 'The background service keeps this data now, so this version of the app can’t change it. Nothing was saved.'
        : 'The app keeps this data again, so the background service didn’t change it. Nothing was saved.',
  };
}

/** A write refused because a row's owner record names another owner. */
export class StorageRowOwnerError extends Error {
  public readonly namespaceId: string;
  public readonly reason: 'owned_elsewhere' | 'record_unreadable';
  public readonly owner: StorageTransitionOwner | undefined;

  public constructor(
    namespaceId: string,
    decision: Extract<RowWriteDecision, { allowed: false }>,
  ) {
    super(decision.message);
    this.name = 'StorageRowOwnerError';
    this.namespaceId = namespaceId;
    this.reason = decision.reason;
    this.owner = decision.owner;
  }
}
