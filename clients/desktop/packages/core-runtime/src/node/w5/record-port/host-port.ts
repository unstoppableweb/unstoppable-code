import { WorkspaceConfigUnreadableError } from '../file-store';
import {
  w5UnderlyingFromDiagnostics,
  isW5FilesystemCode,
} from '../error-diagnostics';
import { W5ProcessFileLockTimeoutError } from '../commit-log/errors';
import {
  CanopyErrorPayloadSchema,
  CoreWorkspaceRecordsWorktreeIdSchema,
  isBoundedCanopyJsonValue,
  type CanopyErrorPayload,
  type CoreWorkspaceRecordsCommitParams,
} from '@canopy/protocol/canopy-core';
import {
  canopyCapabilityUnavailableError,
  canopyInternalError,
  canopyInvalidArgumentError,
} from '../../../runtime/errors';
import {
  StorageWriteRefusedError,
  type StorageWriteRefusalReason,
} from '../../../storage';
import {
  isW5CaptureFile,
  isW5CaptureRequest,
  isW5CaptureWorkspaceId,
  type W5CaptureFile,
  type W5CaptureResult,
} from '../commit-log/capture-contract';
import type {
  W5CommitRequest,
  W5ReceiptLookup,
  W5Reservation,
  W5Resource,
} from '../commit-log/commit-log';
import {
  W5CommitLogError,
  W5CommitRefusedError,
  type W5CommitLogErrorCode,
} from '../commit-log/errors';
import { isRecord } from '../commit-log/is-record';
import type { W5CommitOutcome } from '../commit-log/worker-contract';
import {
  W5FileWriteRefusedError,
  w5ResourceKey,
  type W5CommitLogHostPort,
} from '../commit-log-file-store';
import {
  W5RecordOverloadedError,
  type W5FileRead,
  type W5RecordUnservedReason,
} from '../file-store';
import {
  createW5RecordBatchingReader,
  isW5CaptureLimitRefusal,
  retryW5RecordCapture,
} from './batching-reader';
import {
  w5RecordPathFor,
  w5RecordTargetFor,
  type W5RecordPortTransport,
} from './contract';
import { validateW5RecordCaptureResult } from './capture-result';

/*
 * The host side of the W5 record port (W6g, CAN-5498): a `W5CommitLogHostPort`
 * whose calls go to the daemon authority instead of a local worker. It sends
 * targets only, refusing any other path before sending, and rebuilds the
 * authority's typed refusals as the errors an in-process host throws, with
 * this host's paths. Keyed calls (receipts and reservations, CAN-5506) go to
 * the authority too; reservation diagnostics cross as opaque JSON text this
 * host built and only this host reads (DQ-7 reading (i)).
 */

export type W5RecordConflictKind =
  | 'fingerprint'
  | 'revision'
  | 'unapplied-change'
  | 'recovery-required';

export interface W5RecordHostPortOptions {
  /** This host's W5 root: targets project onto it, and captures read under it. */
  readonly root: string;
  readonly transport: W5RecordPortTransport;
  /** Each refused or unapplied decision, by commit-log label. */
  readonly onConflict?: (event: {
    operation: string;
    kind: W5RecordConflictKind;
  }) => void;
  /**
   * Each refusal of a record this port cannot serve that fails closed here:
   * a commit or revision read naming an unnameable workspace, or an
   * over-limit revision read. By commit-log label, or the capture operation
   * for a read.
   */
  readonly onUnserved?: (event: {
    operation: string;
    reason: W5RecordUnservedReason;
  }) => void;
  /** Bytes each served record read decoded from its captured image. */
  readonly onRecordDecoded?: (bytes: number) => void;
  /** Typed capture refusals, after wire reconstruction, from every capture consumer. */
  readonly onCaptureRefused?: (error: W5CommitRefusedError) => void;
}

const CAPTURE_OPERATION = 'core.workspaceRecords.capture';

const STORAGE_REFUSALS: readonly StorageWriteRefusalReason[] = [
  'invalid_writer',
  'unknown_namespace',
  'ambiguous_namespace',
  'daemon_owned',
  'offline',
  'unlisted_writer',
  'unadmitted_writer',
  'invalid_row',
];
const LOG_CODES: readonly W5CommitLogErrorCode[] = [
  'STORAGE_UNAVAILABLE',
  'WRITER_UNAVAILABLE',
  'UNSUPPORTED_SCHEMA',
];

function typedPayload(error: unknown): CanopyErrorPayload | undefined {
  if (!isRecord(error)) return undefined;
  const parsed = CanopyErrorPayloadSchema.safeParse(error.payload);
  return parsed.success ? parsed.data : undefined;
}

function detail(payload: CanopyErrorPayload, key: string): unknown {
  return isRecord(payload.details) ? payload.details[key] : undefined;
}

/** The named details the payload carries, omitting absent ones. */
function details(
  payload: CanopyErrorPayload,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = detail(payload, key);
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

/** `value` as its JSON text reads back, or undefined if it has none. */
function storedJson(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Diagnostics as the opaque JSON text the authority stores (DQ-7 reading
 * (i)). The owned paths in it stay this host's to read: they can lie outside
 * the W5 root, so no target names them, and the same-host authority parses,
 * stores and returns them without resolving one.
 */
function diagnosticsText(diagnostics: unknown): string {
  let text: unknown;
  try {
    text = JSON.stringify(diagnostics);
  } catch {
    text = undefined;
  }
  if (typeof text !== 'string')
    throw canopyInvalidArgumentError(
      'These reservation diagnostics are not JSON data.',
    );
  return text;
}

function parseDiagnostics(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw canopyInternalError(
      'The W5 record port returned unreadable diagnostics.',
    );
  }
}

function isStorageRefusal(value: unknown): value is StorageWriteRefusalReason {
  return STORAGE_REFUSALS.some((reason) => reason === value);
}

function isLogCode(value: unknown): value is W5CommitLogErrorCode {
  return LOG_CODES.some((code) => code === value);
}

const UNNAMEABLE_WORKSPACE =
  'The daemon record port cannot name this workspace.';

/** Why capture evidence cannot carry `resource`'s revision, if it cannot. */
function nameRefusal(resource: W5Resource): string | undefined {
  if (
    resource.kind !== 'workspaces' &&
    !isW5CaptureWorkspaceId(resource.workspaceId)
  )
    return UNNAMEABLE_WORKSPACE;
  if (
    resource.kind === 'worktree' &&
    !CoreWorkspaceRecordsWorktreeIdSchema.safeParse(resource.worktreeId).success
  )
    return 'The daemon record port cannot name this worktree.';
  return undefined;
}

/** The selector whose capture evidence carries `resource`'s revision. */
function revisionSelector(resource: W5Resource): W5CaptureFile {
  switch (resource.kind) {
    case 'workspaces':
      return { kind: 'index' };
    case 'workspace':
      return { kind: 'manifest', workspaceId: resource.workspaceId };
    case 'worktrees':
    case 'worktree':
      return { kind: 'worktrees', workspaceId: resource.workspaceId };
  }
}

export interface W5RecordHostPort extends W5CommitLogHostPort {
  readFile(path: string, forCommit?: boolean): Promise<W5FileRead>;
}

export function createW5RecordHostPort(
  options: W5RecordHostPortOptions,
): W5RecordHostPort {
  const { root, transport } = options;
  const meter = (operation: string, kind: W5RecordConflictKind): void =>
    options.onConflict?.({ operation, kind });
  const unserved = (operation: string, reason: W5RecordUnservedReason): void =>
    options.onUnserved?.({ operation, reason });
  /** Refuses, before sending, a resource whose revision it could not read back. */
  const assertNameable = (resource: W5Resource, operation: string): void => {
    const refusal = nameRefusal(resource);
    if (refusal === undefined) return;
    // Capture `unsupported-id` is the workspace-id class only.
    if (refusal === UNNAMEABLE_WORKSPACE) unserved(operation, 'unsupported-id');
    throw canopyCapabilityUnavailableError(refusal);
  };
  const pathOf = (value: unknown, fallback: string): string =>
    isW5CaptureFile(value) ? w5RecordPathFor(root, value) : fallback;

  /** The in-process error for a typed authority refusal; others unchanged. */
  function fromWire(
    error: unknown,
    request?: { operation: string; firstPath: string },
  ): unknown {
    const payload = typedPayload(error);
    if (
      payload?.kind === 'resource_exhausted' ||
      (payload?.kind === 'unavailable' &&
        detail(payload, 'w5HostUnavailable') === 'queued-wait')
    )
      return new W5RecordOverloadedError(payload.kind, payload.retry, error);
    if (!payload?.code) return error;
    const operation = request?.operation ?? CAPTURE_OPERATION;
    const firstPath = request?.firstPath ?? root;
    switch (payload.code) {
      case 'core.workspaceRecords.configUnreadable': {
        const code = detail(payload, 'errorCode');
        return new WorkspaceConfigUnreadableError(
          isW5FilesystemCode(code) ? { code } : undefined,
        );
      }
      case 'core.workspaceRecords.fingerprintConflict':
        meter(operation, 'fingerprint');
        return new W5FileWriteRefusedError(
          pathOf(detail(payload, 'target'), firstPath),
        );
      case 'core.workspaceRecords.revisionConflict':
        meter(operation, 'revision');
        return new W5CommitRefusedError('revision-conflict', payload.message, {
          resource: detail(payload, 'resource'),
          expected: detail(payload, 'expected'),
          actual: detail(payload, 'actual'),
        });
      case 'core.workspaceRecords.unappliedChange':
        meter(operation, 'unapplied-change');
        return new W5CommitRefusedError('unapplied-change', payload.message, {
          path: pathOf(detail(payload, 'target'), firstPath),
          commitId: detail(payload, 'commitId'),
          operation: detail(payload, 'operation'),
        });
      case 'core.workspaceRecords.recoveryRequired':
        return new W5CommitRefusedError(
          'recovery-required',
          payload.message,
          details(payload, ['commitId', 'reservationId']),
        );
      case 'core.workspaceRecords.keyReused':
        return new W5CommitRefusedError(
          'key-reused',
          payload.message,
          details(payload, ['commitId', 'reservationId']),
        );
      case 'core.workspaceRecords.outcomeExpired':
        return new W5CommitRefusedError(
          'outcome-expired',
          payload.message,
          details(payload, ['commitId']),
        );
      case 'core.workspaceRecords.inProgress':
        return new W5CommitRefusedError(
          'in-progress',
          payload.message,
          details(payload, ['reservationId']),
        );
      case 'core.workspaceRecords.identityConflict':
        return new W5CommitRefusedError(
          'identity-conflict',
          payload.message,
          details(payload, ['workspaceIdentity']),
        );
      case 'core.workspaceRecords.unknownReservation':
        return new W5CommitRefusedError(
          'unknown-reservation',
          payload.message,
          details(payload, ['reservationId']),
        );
      case 'core.workspaceRecords.captureRefused':
        return new W5CommitRefusedError('invalid-state', payload.message, {
          capture: detail(payload, 'capture'),
        });
      case 'core.workspaceRecords.invalidState':
        return new W5CommitRefusedError(
          'invalid-state',
          payload.message,
          details(payload, ['reservationId', 'expected', 'actual']),
        );
      case 'core.workspaceRecords.writeRefused': {
        const namespaceId = detail(payload, 'namespaceId');
        const reason = detail(payload, 'reason');
        return new StorageWriteRefusedError(
          typeof namespaceId === 'string' ? namespaceId : 'unknown',
          'daemon',
          isStorageRefusal(reason) ? reason : 'invalid_row',
        );
      }
      case 'core.workspaceRecords.logUnavailable': {
        if (detail(payload, 'reason') === 'process-lock-timeout')
          return new W5ProcessFileLockTimeoutError(
            pathOf(detail(payload, 'target'), firstPath),
          );
        const code = detail(payload, 'code');
        return new W5CommitLogError(
          isLogCode(code) ? code : 'STORAGE_UNAVAILABLE',
          payload.message,
          w5UnderlyingFromDiagnostics(payload.details),
        );
      }
      default:
        return error;
    }
  }

  async function capture(
    request: Parameters<W5CommitLogHostPort['capture']>[0],
  ): Promise<W5CaptureResult> {
    if (!isW5CaptureRequest(request))
      throw canopyInvalidArgumentError('This capture is not a W5 record read.');
    let result: unknown;
    try {
      result = await transport.capture(request);
    } catch (error) {
      const refused = fromWire(error);
      if (
        refused instanceof W5CommitRefusedError &&
        refused.reason === 'invalid-state' &&
        typeof refused.details.capture === 'string'
      ) {
        try {
          options.onCaptureRefused?.(refused);
        } catch {
          // Observing must preserve the original typed refusal.
        }
      }
      throw refused;
    }
    return validateW5RecordCaptureResult(result);
  }

  const reader = createW5RecordBatchingReader({
    root,
    capture: (files) =>
      retryW5RecordCapture(() => capture({ files, discoverWorkspaces: false })),
    capturePreparation: (request) =>
      retryW5RecordCapture(() => capture(request)),
    onUnserved: (reason) => unserved(CAPTURE_OPERATION, reason),
    ...(options.onRecordDecoded
      ? { onRecordDecoded: options.onRecordDecoded }
      : {}),
  });

  async function commit(request: W5CommitRequest): Promise<W5CommitOutcome> {
    // A revision this port could not read back is never advanced.
    for (const resource of request.advance)
      assertNameable(resource, request.operation);
    for (const entry of request.expectedRevisions ?? [])
      assertNameable(entry.resource, request.operation);
    const files: CoreWorkspaceRecordsCommitParams['files'] = [];
    for (const file of request.files) {
      const target = w5RecordTargetFor(root, file.path);
      // Refused before sending: only W5 targets cross.
      if (!target)
        throw canopyInvalidArgumentError(
          'This file is not a W5 record under the trusted root.',
        );
      files.push({
        target: { ...target },
        contents: file.contents,
        previousFingerprint: file.previousFingerprint,
      });
    }
    // The JSON the log stores in-process: absent fields drop, as they would.
    const outcome = storedJson(request.outcome ?? null);
    if (!isBoundedCanopyJsonValue(outcome))
      throw canopyInvalidArgumentError(
        'This W5 outcome is not portable JSON data.',
      );
    let result: Awaited<ReturnType<W5RecordPortTransport['commit']>>;
    try {
      result = await transport.commit({
        operation: request.operation,
        ...(request.receipt && { receipt: { ...request.receipt } }),
        ...(request.reservationId !== undefined && {
          reservationId: request.reservationId,
        }),
        ...(request.expectedRevisions && {
          expectedRevisions: request.expectedRevisions.map((entry) => ({
            resource: { ...entry.resource },
            revision: entry.revision,
          })),
        }),
        advance: request.advance.map((resource) => ({ ...resource })),
        files,
        outcome,
      });
    } catch (error) {
      throw fromWire(error, {
        operation: request.operation,
        firstPath: request.files[0]?.path ?? root,
      });
    }
    switch (result.status) {
      case 'applied':
        return {
          status: 'applied',
          commitId: result.commitId,
          revisions: result.revisions,
        };
      case 'replayed':
        return {
          status: 'replayed',
          commitId: result.commitId,
          outcome: result.outcome,
        };
      case 'replay-expired':
        return { status: 'replay-expired', commitId: result.commitId };
      case 'recovery-required':
        meter(request.operation, 'recovery-required');
        // Path-free on the wire: only the counts cross, and this host reads none.
        return {
          status: 'recovery-required',
          commitId: result.commitId,
          revisions: result.revisions,
          apply: { status: 'recovery-required', conflicts: [], written: [] },
        };
    }
  }

  /** Runs one keyed call, rebuilding the authority's typed refusals. */
  async function keyed<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw fromWire(error);
    }
  }

  async function lookupReceipt(
    receipt: NonNullable<W5CommitRequest['receipt']>,
  ): Promise<W5ReceiptLookup> {
    const lookup = await keyed(() =>
      transport.lookupReceipt({
        caller: receipt.caller,
        operation: receipt.operation,
        idempotencyKey: receipt.idempotencyKey,
        fingerprint: receipt.fingerprint,
      }),
    );
    switch (lookup.status) {
      case 'commit-recovery-required':
        // The authority's apply diagnostics cross as counts only.
        return {
          status: 'commit-recovery-required',
          commitId: lookup.commitId,
          diagnostics: {
            conflictCount: lookup.conflictCount,
            writtenFileCount: lookup.writtenFileCount,
            unexpectedFailure: lookup.unexpectedFailure,
          },
        };
      case 'recovery-required':
        return {
          status: 'recovery-required',
          reservationId: lookup.reservationId,
          diagnostics: parseDiagnostics(lookup.diagnostics),
        };
      default:
        return lookup;
    }
  }

  async function reservations(): Promise<W5Reservation[]> {
    const { reservations: entries } = await keyed(() =>
      transport.listReservations(),
    );
    return entries.map((entry) => ({
      reservationId: entry.reservationId,
      operation: entry.operation,
      state: entry.state,
      diagnostics: parseDiagnostics(entry.diagnostics),
    }));
  }

  return {
    root,
    async recoveryReport() {
      const report = await keyed(() => transport.recovery());
      // Reservation records, whose diagnostics this host built, come from
      // their own read; the store's launch warnings and identity reads use them.
      const live = await reservations();
      return {
        ...(report.abandoned?.length ? { abandoned: report.abandoned } : {}),
        applied: report.applied,
        recoveryRequired: report.recoveryRequired,
        recoveryRequiredDetails: report.recoveryRequiredDetails,
        interruptedReservations: report.interruptedReservations,
        recoveryRequiredReservations: report.recoveryRequiredReservations,
        ...(live.length ? { reservations: live } : {}),
      };
    },
    commit,
    capture,
    ...(reader.captureForPreparation
      ? { captureForPreparation: reader.captureForPreparation.bind(reader) }
      : {}),
    readFile: (path, forCommit) => reader.readFile(path, forCommit),
    async revision(resource, forCommit = false) {
      assertNameable(resource, CAPTURE_OPERATION);
      let result: W5CaptureResult;
      try {
        result = await reader.captureFile(
          revisionSelector(resource),
          forCommit,
        );
      } catch (error) {
        // Only here and in a host's one-file read does the class fail closed;
        // an over-limit query capture reads its files one at a time instead.
        if (isW5CaptureLimitRefusal(error))
          unserved(CAPTURE_OPERATION, 'limit-exceeded');
        throw error;
      }
      return result.log.revisions[w5ResourceKey(resource)] ?? 0;
    },
    lookupReceipt,
    async reserve(input) {
      const diagnostics =
        input.diagnostics === undefined
          ? undefined
          : diagnosticsText(input.diagnostics);
      await keyed(() =>
        transport.reserve({
          reservationId: input.reservationId,
          ...(input.workspaceIdentity !== undefined && {
            workspaceIdentity: input.workspaceIdentity,
          }),
          ...(input.expectedWorkspaceRecords !== undefined && {
            expectedWorkspaceRecords: input.expectedWorkspaceRecords,
          }),
          operation: input.operation,
          ...(input.receipt && { receipt: { ...input.receipt } }),
          ...(diagnostics !== undefined && { diagnostics }),
        }),
      );
    },
    async updateReservationDiagnostics(reservationId, diagnostics) {
      const text = diagnosticsText(diagnostics);
      await keyed(() =>
        transport.updateReservationDiagnostics({
          reservationId,
          diagnostics: text,
        }),
      );
    },
    async releaseReservation(reservationId) {
      await keyed(() => transport.releaseReservation(reservationId));
    },
    async markReservationRecoveryRequired(reservationId, diagnostics) {
      await keyed(() =>
        transport.markReservationRecoveryRequired({
          reservationId,
          diagnostics: {
            operation: diagnostics.operation,
            errorName: diagnostics.errorName,
            ...(diagnostics.errorCode !== undefined && {
              errorCode: diagnostics.errorCode,
            }),
          },
        }),
      );
    },
  };
}
