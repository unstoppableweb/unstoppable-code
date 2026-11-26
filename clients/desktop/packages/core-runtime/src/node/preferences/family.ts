import { storageRecordsFolder } from '../../storage/owner-records';

/*
 * Where the preferences family lives in the data root (CAN-7924). No file
 * system access, so interface path helpers may import it.
 */

/** The preferences storage row (storage-ownership.yaml). */
export const PREFERENCES_NAMESPACE_ID = 'preferences';

/**
 * The family's live files, in the order a restore puts them back: the
 * usage-data denials first and the document last, so a revocation and the
 * generation record are in place before any document they govern.
 */
export const PREFERENCES_FAMILY_FILES = [
  'preferences.json.usage-data-denied.json',
  'preferences.generation.json',
  'preferences.last-good.json',
  'preferences.json',
] as const;

/** Data-root-relative folder holding every preferences backup, one subfolder each. */
export const PREFERENCES_BACKUPS_FOLDER = 'backups/preferences';

/** Data-root-relative folder of the preferences row's owner records. */
export const PREFERENCES_OWNER_RECORDS_FOLDER = storageRecordsFolder(
  PREFERENCES_NAMESPACE_ID,
);
