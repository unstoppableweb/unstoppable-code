import { isRecord } from '../w5/commit-log/is-record';

export type PreferencesDocumentSlot = 'primary' | 'lastGood' | 'generation';

/** One preferences document, bound by the host to its storage. */
export interface PreferencesDocument {
  readonly key: string;
  readText(slot: PreferencesDocumentSlot): Promise<string>;
  /** Resolves false only for ENOENT; any other failure rejects. */
  exists(slot: 'primary' | 'lastGood'): Promise<boolean>;
  install(slot: PreferencesDocumentSlot, content: string): Promise<void>;
  /** Makes the document's folder durable up to the host's data root. */
  ensureFolder(): Promise<void>;
  /** Display path of a slot, used in load errors (`restoredFromPath`). */
  slotPath(slot: PreferencesDocumentSlot): string;
  /** Where a recovery keeps the unreadable primary for `stamp`. */
  backupLocation(stamp: string): string;
  /** Installs a backup at a location from `backupLocation`, atomically and durably. */
  installBackup(location: string, content: string): Promise<void>;
  /** Keeps the newest five backups. */
  pruneBackups(): Promise<void>;
}

export interface PreferencesLog {
  error(message: string, error: unknown): void;
  /** Something handled without the person, worth a log line; `error` when absent. */
  warn?(message: string, details: unknown): void;
}

/** Logs through `warn`, or `error` when the host gave none. */
export function logPreferencesWarning(
  log: PreferencesLog,
  message: string,
  details: unknown,
): void {
  if (log.warn) log.warn(message, details);
  else log.error(message, details);
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

/** True for ENOENT by code or message, as the desktop store has always tested. */
export function isMissingDocumentError(error: unknown): boolean {
  return (
    getErrorCode(error) === 'ENOENT' || getErrorMessage(error) === 'ENOENT'
  );
}
