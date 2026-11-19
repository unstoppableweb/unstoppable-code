import { WorkspaceConfigUnreadableError } from '../file-store';
import {
  w5UnderlyingDiagnostics,
  w5ErrorDiagnostics,
  isW5FilesystemCode,
} from '../error-diagnostics';
import { w5DaemonReceiptCaller } from '../workspace-metadata/receipt-caller';
import { isW5CommitOutcome } from '../commit-log/worker-contract';
import { W5ProcessFileLockTimeoutError } from '../commit-log/errors';
import {
  CORE_WORKSPACE_RECORDS_ERROR_KINDS,
  CORE_WORKSPACE_RECORDS_LIMITS,
  type CanopyCallerDescriptor,
  type CanopyJsonValue,
  type CanopyRetryDirective,
  type CoreWorkspaceRecordsCaptureResult,
  type CoreWorkspaceRecordsCommitParams,
  type CoreWorkspaceRecordsCommitResult,
  type CoreWorkspaceRecordsErrorCode,
  type CoreWorkspaceRecordsFailureDiagnostics,
  type CoreWorkspaceRecordsReceipt,
  type CoreWorkspaceRecordsReceiptLookup,
  type CoreWorkspaceRecordsRecovery,
  type CoreWorkspaceRecordsReservationList,
  type CoreWorkspaceRecordsReserveParams,
  isBoundedCanopyJsonValue,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  canopyCapabilityUnavailableError,
  canopyInternalError,
  canopyInvalidArgumentError,
} from '../../../runtime/errors';
import {
  assertStorageWriteAllowed,
  STORAGE_OWNERSHIP,
  StorageWriteRefusedError,
  type GuardedStorageNamespace,
} from '../../../storage';
import type {
  W5CaptureRequest,
  W5CaptureResult,
} from '../commit-log/capture-contract';
import type {
  W5CommitRequest,
  W5ReceiptLookup,
} from '../commit-log/commit-log';
import { W5CommitLogHostError } from '../commit-log-host';
import { W5CommitLogError, W5CommitRefusedError } from '../commit-log/errors';
import { isRecord } from '../commit-log/is-record';
import { workspaceCreationDiagnosticsSchema } from '../commit-log/reservation-diagnostics';
import {
  preflightW5Files,
  runInW5CommitQueue,
  W5FileWriteRefusedError,
  type W5CommitLogHostPort,
} from '../commit-log-file-store';
import { readNodeW5File, type W5FileRead } from '../file-store';
import {
  w5RecordNamespace,
  w5RecordPathFor,
  w5RecordTargetFor,
  w5ResourceNamespace,
} from './contract';

/*
 * The daemon side of the W5 record port (W6g, CAN-5498): the only place a
 * target becomes a host path. It checks ownership as `daemon`, then runs the
 * authoritative fingerprint preflight and the decision in the host's final
 * decision queue, which every authority-routed writer on that host shares, so
 * a racing routed write is a pre-decision conflict, never a recovery (E9).
 * A keyed commit already decided replays despite a preflight conflict, as the
 * log orders it. Receipt lookups and reservations (CAN-5506) reach the same
 * host unqueued, as in-process, once ownership admits `daemon` for every W5
 * record namespace. Reservation diagnostics are Electron's opaque payload (DQ-7
 * reading (i)): this side parses them as JSON, schema-checks an update as the
 * log does, and stores and returns them, but never resolves or projects a path
 * in them.
 */

function receiptForCaller(
  receipt: CoreWorkspaceRecordsReceipt,
  caller?: CanopyCallerDescriptor,
): CoreWorkspaceRecordsReceipt {
  return caller?.interfaceKind === 'cli'
    ? {
        ...receipt,
        caller: w5DaemonReceiptCaller(caller.principalId, receipt.caller),
      }
    : { ...receipt };
}

export interface W5RecordAuthorityOptions {
  /** The daemon's W5 host; its identity keys the shared decision queue. */
  readonly host: W5CommitLogHostPort;
  /**
   * The view one caller's commits go through. W5e supplies an attributed
   * view (`port({ publishedBy })`); until then every caller uses `host`.
   */
  readonly portFor?: (caller: CanopyCallerDescriptor) => W5CommitLogHostPort;
  /** Direct reads for the preflight; defaults to Node reads. */
  readonly readFile?: (filePath: string) => Promise<W5FileRead>;
}

export interface W5RecordAuthority {
  capture(
    request: W5CaptureRequest,
  ): Promise<CoreWorkspaceRecordsCaptureResult>;
  recovery(): Promise<CoreWorkspaceRecordsRecovery>;
  commit(
    caller: CanopyCallerDescriptor,
    request: CoreWorkspaceRecordsCommitParams,
  ): Promise<CoreWorkspaceRecordsCommitResult>;
  lookupReceipt(
    receipt: CoreWorkspaceRecordsReceipt,
    caller?: CanopyCallerDescriptor,
  ): Promise<CoreWorkspaceRecordsReceiptLookup>;
  listReservations(): Promise<CoreWorkspaceRecordsReservationList>;
  reserve(
    params: CoreWorkspaceRecordsReserveParams,
    caller?: CanopyCallerDescriptor,
  ): Promise<void>;
  updateReservationDiagnostics(
    reservationId: string,
    diagnostics: string,
  ): Promise<void>;
  releaseReservation(reservationId: string): Promise<void>;
  markReservationRecoveryRequired(
    reservationId: string,
    diagnostics: CoreWorkspaceRecordsFailureDiagnostics,
  ): Promise<void>;
}

const MESSAGES: Readonly<Record<CoreWorkspaceRecordsErrorCode, string>> = {
  'core.workspaceRecords.configUnreadable': new WorkspaceConfigUnreadableError()
    .message,
  'core.workspaceRecords.identityConflict':
    'This workspace identity is already reserved or occupied.',
  'core.workspaceRecords.fingerprintConflict':
    'This was changed since it was read. Reload and try again.',
  'core.workspaceRecords.revisionConflict':
    'This was changed since it was read. Reload and try again.',
  'core.workspaceRecords.recoveryRequired':
    'An earlier change needs recovery before this can be saved.',
  'core.workspaceRecords.unappliedChange':
    'An earlier change to this project has not finished saving.',
  'core.workspaceRecords.invalidState':
    'This change is not in the state the request needs.',
  'core.workspaceRecords.captureRefused': 'The W5 records cannot be read.',
  'core.workspaceRecords.writeRefused':
    'Storage ownership does not admit this writer.',
  'core.workspaceRecords.logUnavailable': 'The W5 commit log is unavailable.',
  'core.workspaceRecords.keyReused':
    'This request was already used with different details.',
  'core.workspaceRecords.outcomeExpired':
    'This request was already completed; its saved outcome has expired.',
  'core.workspaceRecords.inProgress': 'This request is still in progress.',
  'core.workspaceRecords.unknownReservation':
    'This operation is no longer reserved.',
};

/**
 * A receipt or reservation is part of a W5 decision, so writing one needs the
 * daemon admitted for every W5 record namespace: while they are legacy the
 * daemon fails closed and writes nothing, as a commit does.
 */
const KEYED_WRITE_NAMESPACES: readonly GuardedStorageNamespace[] = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];

const AFTER_REFRESH: CanopyRetryDirective = {
  kind: 'after_refresh',
  resource: 'core.workspaceRecords',
};
const NEVER: CanopyRetryDirective = { kind: 'never' };

function wireError(
  code: CoreWorkspaceRecordsErrorCode,
  details: Record<string, CanopyJsonValue>,
  retry: CanopyRetryDirective,
  cause: unknown,
  message = MESSAGES[code],
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: CORE_WORKSPACE_RECORDS_ERROR_KINDS[code],
      code,
      message,
      details,
      retry,
    },
    cause,
  );
}

function jsonField(
  details: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, CanopyJsonValue> {
  const value = details[key];
  return typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
    ? { [key]: value }
    : {};
}

function refusalWireError(
  error: W5CommitRefusedError,
  root: string,
): CanopyOperationError {
  const { details } = error;
  switch (error.reason) {
    case 'revision-conflict':
      return wireError(
        'core.workspaceRecords.revisionConflict',
        {
          ...jsonField(details, 'resource'),
          ...jsonField(details, 'expected'),
          ...jsonField(details, 'actual'),
        },
        AFTER_REFRESH,
        error,
      );
    case 'unapplied-change': {
      const path = details.path;
      const target =
        typeof path === 'string' ? w5RecordTargetFor(root, path) : undefined;
      const operation =
        typeof details.operation === 'string' &&
        /^[A-Za-z0-9_.-]{1,256}$/.test(details.operation)
          ? details.operation
          : undefined;
      return wireError(
        'core.workspaceRecords.unappliedChange',
        {
          ...(target ? { target: { ...target } } : {}),
          ...jsonField(details, 'commitId'),
          ...(operation ? { operation } : {}),
        },
        NEVER,
        error,
        `An earlier change (commit ${typeof details.commitId === 'number' ? details.commitId : 'unknown'}, ${operation ?? 'unknown operation'}) to ${target?.kind === 'worktrees' ? 'the worktree list' : target?.kind === 'manifest' ? 'the project record' : target ? 'the project list' : 'this project'} has not finished saving.`,
      );
    }
    case 'recovery-required':
      return wireError(
        'core.workspaceRecords.recoveryRequired',
        {
          ...jsonField(details, 'commitId'),
          ...jsonField(details, 'reservationId'),
        },
        NEVER,
        error,
      );
    case 'key-reused':
      return wireError(
        'core.workspaceRecords.keyReused',
        {
          ...jsonField(details, 'commitId'),
          ...jsonField(details, 'reservationId'),
        },
        NEVER,
        error,
      );
    case 'outcome-expired':
      return wireError(
        'core.workspaceRecords.outcomeExpired',
        jsonField(details, 'commitId'),
        NEVER,
        error,
      );
    case 'in-progress':
      return wireError(
        'core.workspaceRecords.inProgress',
        jsonField(details, 'reservationId'),
        NEVER,
        error,
      );
    case 'identity-conflict':
      return wireError(
        'core.workspaceRecords.identityConflict',
        jsonField(details, 'workspaceIdentity'),
        NEVER,
        error,
      );
    case 'unknown-reservation':
      return wireError(
        'core.workspaceRecords.unknownReservation',
        jsonField(details, 'reservationId'),
        NEVER,
        error,
      );
    case 'invalid-state':
      if (typeof details.capture === 'string')
        return wireError(
          'core.workspaceRecords.captureRefused',
          jsonField(details, 'capture'),
          NEVER,
          error,
        );
      return wireError(
        'core.workspaceRecords.invalidState',
        {
          reason: error.reason,
          // A reservation in the wrong state names its id and both states.
          ...jsonField(details, 'reservationId'),
          ...jsonField(details, 'expected'),
          ...jsonField(details, 'actual'),
        },
        NEVER,
        error,
      );
  }
}

/** Projects a failure onto the wire: typed codes, no host path or raw text. */
export function toW5RecordWireError(
  error: unknown,
  root: string,
): CanopyOperationError {
  if (error instanceof CanopyOperationError) return error;
  if (error instanceof W5ProcessFileLockTimeoutError) {
    const target = w5RecordTargetFor(root, error.path);
    return wireError(
      'core.workspaceRecords.logUnavailable',
      {
        reason: 'process-lock-timeout',
        ...(target ? { target: { ...target } } : {}),
      },
      NEVER,
      error,
      error.message,
    );
  }
  if (
    error instanceof W5CommitLogHostError &&
    error.reason === 'unavailable' &&
    error.unavailableCause
  ) {
    const full = error.unavailableCause === 'queue-full';
    return new CanopyOperationError(
      {
        kind: full ? 'resource_exhausted' : 'unavailable',
        message: 'The W5 record port is busy.',
        retry: full ? { kind: 'same_request', delayMs: 10 } : { kind: 'never' },
        details: { w5HostUnavailable: error.unavailableCause },
      },
      error,
    );
  }
  if (error instanceof W5FileWriteRefusedError) {
    const target = w5RecordTargetFor(root, error.path);
    return wireError(
      'core.workspaceRecords.fingerprintConflict',
      target ? { target: { ...target } } : {},
      AFTER_REFRESH,
      error,
    );
  }
  if (error instanceof WorkspaceConfigUnreadableError) {
    const { errorCode } = w5ErrorDiagnostics(error);
    return wireError(
      'core.workspaceRecords.configUnreadable',
      isW5FilesystemCode(errorCode) ? { errorCode } : {},
      NEVER,
      error,
    );
  }
  if (error instanceof W5CommitRefusedError)
    return refusalWireError(error, root);
  if (error instanceof StorageWriteRefusedError)
    return wireError(
      'core.workspaceRecords.writeRefused',
      { namespaceId: error.namespaceId, reason: error.reason },
      NEVER,
      error,
    );
  if (error instanceof W5CommitLogError)
    return wireError(
      'core.workspaceRecords.logUnavailable',
      { code: error.code, ...w5UnderlyingDiagnostics(error.underlying) },
      NEVER,
      error,
    );
  // A worker or host failure: the decision may or may not have been made.
  return canopyInternalError('The W5 record port call failed.', error);
}

function capturedResult(
  result: W5CaptureResult,
): CoreWorkspaceRecordsCaptureResult {
  const wire: CoreWorkspaceRecordsCaptureResult = {
    files: result.files.map((file) => ({ ...file })),
    discovery: result.discovery,
    log: {
      ...result.log,
      revisions: { ...result.log.revisions },
      files: result.log.files.map((row) => ({ ...row, file: { ...row.file } })),
      chains: result.log.chains.map((row) => ({
        ...row,
        file: { ...row.file },
      })),
    },
  };
  // Below one frame; the host reads a refused capture live.
  if (
    Buffer.byteLength(JSON.stringify(wire)) >
    CORE_WORKSPACE_RECORDS_LIMITS.resultBytes
  )
    throw new W5CommitRefusedError(
      'invalid-state',
      'The W5 capture exceeds its limits.',
      { capture: 'limit-exceeded' },
    );
  return wire;
}

/**
 * A saved outcome, which crosses only as bounded JSON data. Rebuilt from its
 * JSON first: the log stores JSON text, and a worker's structured clone can
 * carry another realm's prototypes.
 */
function portableOutcome(outcome: unknown): CanopyJsonValue {
  let value: unknown;
  try {
    const text = JSON.stringify(outcome);
    value = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    value = undefined;
  }
  if (!isBoundedCanopyJsonValue(value))
    throw canopyCapabilityUnavailableError(
      'This saved outcome is not portable JSON data.',
    );
  return value;
}

/** Opaque diagnostics text, as the log stores it. */
function diagnosticsText(diagnostics: unknown): string {
  return JSON.stringify(diagnostics ?? null);
}

function parseDiagnostics(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw canopyInvalidArgumentError(
      'These reservation diagnostics are not JSON text.',
    );
  }
}

/**
 * A lookup projected onto the wire. The authority's own apply diagnostics,
 * which name its paths, cross as counts; reservation diagnostics cross as
 * the opaque text their host stored.
 */
function receiptLookupResult(
  lookup: W5ReceiptLookup,
): CoreWorkspaceRecordsReceiptLookup {
  switch (lookup.status) {
    case 'none':
    case 'key-reused':
      return { status: lookup.status };
    case 'replay':
      return {
        status: 'replay',
        commitId: lookup.commitId,
        outcome: portableOutcome(lookup.outcome),
      };
    case 'replay-expired':
      return { status: 'replay-expired', commitId: lookup.commitId };
    case 'commit-recovery-required': {
      // As the log counts its launch report's details.
      const diagnostics = isRecord(lookup.diagnostics)
        ? lookup.diagnostics
        : {};
      return {
        status: 'commit-recovery-required',
        commitId: lookup.commitId,
        conflictCount: Array.isArray(diagnostics.conflicts)
          ? diagnostics.conflicts.length
          : 0,
        writtenFileCount: Array.isArray(diagnostics.written)
          ? diagnostics.written.length
          : 0,
        unexpectedFailure: typeof diagnostics.error === 'string',
      };
    }
    case 'in-progress':
      return { status: 'in-progress', reservationId: lookup.reservationId };
    case 'recovery-required':
      return {
        status: 'recovery-required',
        reservationId: lookup.reservationId,
        diagnostics: diagnosticsText(lookup.diagnostics),
      };
  }
}

/**
 * The preflight, unless a keyed request was already decided: the log replays
 * that whatever the files hold now, as the in-process host does, and a retry
 * after a lost response names the fingerprints its own decision replaced.
 * Every other key state keeps the conflict, as the in-process store orders it.
 */
async function preflightUnlessDecided(
  host: W5CommitLogHostPort,
  readFile: (filePath: string) => Promise<W5FileRead>,
  request: W5CommitRequest,
): Promise<void> {
  try {
    await preflightW5Files(readFile, request.files);
  } catch (error) {
    if (!(error instanceof W5FileWriteRefusedError) || !request.receipt)
      throw error;
    const { status } = await host.lookupReceipt(request.receipt);
    if (status !== 'replay' && status !== 'replay-expired') throw error;
  }
}

export function createW5RecordAuthority(
  options: W5RecordAuthorityOptions,
): W5RecordAuthority {
  const { host } = options;
  const portFor = options.portFor ?? ((): W5CommitLogHostPort => host);
  const readFile = options.readFile ?? readNodeW5File;
  const wire = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw toW5RecordWireError(error, host.root);
    }
  };
  const keyedWrite = (work: () => Promise<void>): Promise<void> =>
    wire(() => {
      for (const namespace of KEYED_WRITE_NAMESPACES)
        assertStorageWriteAllowed(namespace, 'daemon', STORAGE_OWNERSHIP);
      return work();
    });
  return {
    capture: (request) =>
      wire(async () => capturedResult(await host.capture(request))),
    recovery: () =>
      wire(async () => {
        const report = await host.recoveryReport();
        return {
          ...(report.abandoned?.length
            ? {
                abandoned: report.abandoned
                  .slice(0, CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows)
                  .map((entry) => ({ ...entry })),
              }
            : {}),
          applied: [...report.applied],
          recoveryRequired: [...report.recoveryRequired],
          recoveryRequiredDetails: (report.recoveryRequiredDetails ?? []).map(
            (detail) => ({ ...detail }),
          ),
          interruptedReservations: report.interruptedReservations,
          recoveryRequiredReservations: [
            ...(report.recoveryRequiredReservations ?? []),
          ],
        };
      }),
    commit: (caller, params) =>
      wire(async () => {
        const files = params.files.map((file) => ({
          path: w5RecordPathFor(host.root, file.target),
          contents: file.contents,
          previousFingerprint: file.previousFingerprint,
        }));
        const keyed =
          params.receipt !== undefined || params.reservationId !== undefined;
        // Every record the decision names, revisions included, as the
        // authority's own principal; the caller's is never trusted.
        const namespaces = new Set([
          ...params.files.map((file) => w5RecordNamespace(file.target)),
          ...params.advance.map(w5ResourceNamespace),
          ...(params.expectedRevisions ?? []).map((entry) =>
            w5ResourceNamespace(entry.resource),
          ),
          // A keyed commit may name no record: it records only its receipt
          // or completes its reservation, as in-process.
          ...(keyed ? KEYED_WRITE_NAMESPACES : []),
        ]);
        if (!namespaces.size)
          throw canopyInvalidArgumentError(
            'This W5 record commit names no record.',
          );
        for (const namespace of namespaces)
          assertStorageWriteAllowed(namespace, 'daemon', STORAGE_OWNERSHIP);
        const request: W5CommitRequest = {
          operation: params.operation,
          ...(params.receipt && {
            receipt: receiptForCaller(params.receipt, caller),
          }),
          ...(params.reservationId !== undefined && {
            reservationId: params.reservationId,
          }),
          expectedRevisions: params.expectedRevisions,
          advance: params.advance,
          files,
          outcome: params.outcome,
        };
        const outcome = await runInW5CommitQueue(host, async () => {
          // A failed earlier call can retire the worker with a decided change
          // its replacement applies only at launch recovery; finish that
          // before the preflight reads, as the in-process store does.
          await host.recoveryReport();
          await preflightUnlessDecided(host, readFile, request);
          return portFor(caller).commit(request);
        });
        switch (outcome.status) {
          case 'applied':
            return {
              status: 'applied',
              commitId: outcome.commitId,
              revisions: { ...outcome.revisions },
            };
          case 'conflict': {
            if (!isW5CommitOutcome(outcome))
              throw canopyInternalError(
                'The W5 conflict outcome is malformed.',
              );
            const conflict = outcome.conflicts[0];
            const target =
              conflict && w5RecordTargetFor(host.root, conflict.path);
            if (!target)
              throw canopyInternalError(
                'The W5 conflict target cannot be mapped.',
              );
            throw wireError(
              'core.workspaceRecords.fingerprintConflict',
              { target: { ...target } },
              AFTER_REFRESH,
              outcome,
            );
          }
          case 'recovery-required':
            return {
              status: 'recovery-required',
              commitId: outcome.commitId,
              revisions: { ...outcome.revisions },
              conflictCount: outcome.apply.conflicts.length,
              writtenFileCount: outcome.apply.written.length,
              unexpectedFailure: outcome.apply.error !== undefined,
            };
          case 'replayed':
            return {
              status: 'replayed',
              commitId: outcome.commitId,
              outcome: portableOutcome(outcome.outcome),
            };
          case 'replay-expired':
            return { status: 'replay-expired', commitId: outcome.commitId };
        }
      }),
    // Keyed admission and reservations are not queued, as in-process: the
    // log orders them, and only final decisions share the queue.
    lookupReceipt: (receipt, caller) =>
      wire(async () =>
        receiptLookupResult(
          await host.lookupReceipt(receiptForCaller(receipt, caller)),
        ),
      ),
    listReservations: () =>
      wire(async () => {
        const report = await host.recoveryReport();
        const result: CoreWorkspaceRecordsReservationList = {
          reservations: (report.reservations ?? []).map((entry) => ({
            reservationId: entry.reservationId,
            operation: entry.operation,
            state: entry.state,
            diagnostics: diagnosticsText(entry.diagnostics),
          })),
        };
        if (
          result.reservations.length >
            CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows ||
          Buffer.byteLength(JSON.stringify(result)) >
            CORE_WORKSPACE_RECORDS_LIMITS.resultBytes
        )
          throw new W5CommitRefusedError(
            'invalid-state',
            'The W5 reservations exceed their limits.',
          );
        return result;
      }),
    reserve: (params, caller) =>
      keyedWrite(() =>
        host.reserve({
          reservationId: params.reservationId,
          ...(params.workspaceIdentity !== undefined && {
            workspaceIdentity: params.workspaceIdentity,
          }),
          ...(params.expectedWorkspaceRecords !== undefined && {
            expectedWorkspaceRecords: params.expectedWorkspaceRecords,
          }),
          operation: params.operation,
          ...(params.receipt && {
            receipt: receiptForCaller(params.receipt, caller),
          }),
          ...(params.diagnostics !== undefined && {
            diagnostics: parseDiagnostics(params.diagnostics),
          }),
        }),
      ),
    updateReservationDiagnostics: (reservationId, text) =>
      keyedWrite(async () => {
        const diagnostics = workspaceCreationDiagnosticsSchema.safeParse(
          parseDiagnostics(text),
        );
        // The log's own refusal of diagnostics it would not store.
        if (!diagnostics.success)
          throw new W5CommitRefusedError(
            'invalid-state',
            'Invalid reservation diagnostics.',
          );
        await host.updateReservationDiagnostics(
          reservationId,
          diagnostics.data,
        );
      }),
    releaseReservation: (reservationId) =>
      keyedWrite(() => host.releaseReservation(reservationId)),
    markReservationRecoveryRequired: (reservationId, diagnostics) =>
      keyedWrite(() =>
        host.markReservationRecoveryRequired(reservationId, {
          operation: diagnostics.operation,
          errorName: diagnostics.errorName,
          ...(diagnostics.errorCode !== undefined && {
            errorCode: diagnostics.errorCode,
          }),
        }),
      ),
  };
}
