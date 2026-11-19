/**
 * The secure-store boundary for the cloud account credential (CAN-4168).
 *
 * Electron main implements this port over its encrypted account file until the
 * vault (CAN-4506) takes custody. Core never reads the file, the encryption
 * policy or the storage paths; it sees records and storage status only through
 * this port. The record type stays generic so core holds no desktop types.
 */

/** Holds the last good read; owned by the caller, keyed by storage backend. */
export interface CloudCredentialReadCache<TRecord> {
  get(backendKey: string): TRecord | null | undefined;
  set(record: TRecord | null, backendKey: string): void;
}

/** A read reports storage failure instead of throwing it. */
export type CloudCredentialRead<TRecord, TFailure> =
  | {
      readonly status: 'ok';
      readonly record: TRecord | null;
      readonly migrationWriteFailure?: TFailure;
    }
  | {
      readonly status: 'unavailable';
      readonly error: unknown;
      readonly failure: TFailure;
    }
  | {
      readonly status: 'error';
      readonly error: unknown;
      readonly failure?: TFailure;
    };

/** Moves unreadable bytes aside under a fresh backup name. */
export interface CloudCredentialQuarantine {
  readonly backupFileName: string;
  move(): Promise<void>;
}

/** What explicit recovery finds in the store. */
export type CloudCredentialRecovery<TRecord> =
  | { readonly status: 'absent' }
  | { readonly status: 'readable'; readonly record: TRecord }
  | {
      readonly status: 'unreadable';
      prepareQuarantine(): Promise<CloudCredentialQuarantine>;
    };

export interface CloudCredentialPort<TRecord, TFailure, TStorageStatus> {
  /** Current record or a typed storage failure; consults `cache` first. */
  read(
    cache?: CloudCredentialReadCache<TRecord>,
  ): Promise<CloudCredentialRead<TRecord, TFailure>>;
  /** Replaces the stored record; returns the backend key it was written under. */
  write(record: TRecord): Promise<string>;
  /** Removes the stored record, legacy copies included. */
  clear(): Promise<void>;
  /** Reads for explicit recovery; throws on failures recovery cannot fix. */
  inspectForRecovery(): Promise<CloudCredentialRecovery<TRecord>>;
  isWritable(): boolean;
  /** The secure store's state and backend, for status projections. */
  storageStatus(): TStorageStatus;
  /** Throws a typed storage-unavailable error when writes cannot succeed. */
  assertWritable(): void;
  /** Identifies the platform and storage backend a cached read belongs to. */
  backendKey(): string;
}
