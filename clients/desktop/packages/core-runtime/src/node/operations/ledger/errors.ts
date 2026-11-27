export type OperationLedgerErrorCode =
  | 'STORAGE_UNAVAILABLE'
  | 'WRITER_UNAVAILABLE'
  | 'UNSUPPORTED_SCHEMA'
  | 'BACKUP_UNVERIFIED'
  | 'NEWER_STATE';

/** The ledger itself could not be used; nothing was recorded. */
export class OperationLedgerError extends Error {
  constructor(
    readonly code: OperationLedgerErrorCode,
    message: string,
    /** The storage error behind this one, when there is one. */
    readonly underlying?: unknown,
  ) {
    super(message);
    this.name = 'OperationLedgerError';
  }
}

export class OperationLedgerOutcomeUnknownError extends Error {
  constructor(
    readonly operation: string,
    readonly underlying?: unknown,
  ) {
    super(
      'The operation ledger did not answer, so the write may have been recorded.',
    );
    this.name = 'OperationLedgerOutcomeUnknownError';
  }
}

export type OperationLedgerRefusal =
  | 'not-found'
  | 'key-reused'
  | 'unknown-parent'
  | 'invalid-state'
  | 'revision-conflict';

/** A ledger write the current state refuses. A refusal changes nothing. */
export class OperationLedgerRefusedError extends Error {
  readonly refusal: OperationLedgerRefusal;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    refusal: OperationLedgerRefusal,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'OperationLedgerRefusedError';
    this.refusal = refusal;
    this.details = details;
  }
}
