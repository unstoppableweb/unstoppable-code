import { CanopyClientError } from '@canopy/core-client';
import { canopyDaemonRefusal } from '@canopy/core-client/node';
import {
  W5RecoveryReasonSchema,
  type W5RecoveryEntry,
  type W5RecoveryReason,
  type W5RecoveryStatus,
} from '@canopy/protocol/portal';
import { isRecord } from './type-guards';
import {
  W5MaintenanceDecisionError,
  W5MaintenanceRefusedError,
  type W5MaintenanceDecision,
  type W5MaintenanceDecisionResult,
  type W5MaintenanceRequest,
  type W5MaintenanceResult,
} from '@canopy/core-runtime/node/w5/maintenance-types';
import {
  readW5MaintenanceDecisions,
  W5_RESOLVABLE_RESERVATION_OPERATIONS,
} from './w5-maintenance-decisions';
import type { W5Diagnosis } from './w5-maintenance-diagnosis';

export interface W5RecoveryLaunchPorts {
  waitForRelease(): Promise<void>;
  maintenance(request: W5MaintenanceRequest): Promise<W5MaintenanceResult>;
  choose(
    diagnosis: W5Diagnosis,
  ): Promise<readonly W5MaintenanceDecision[] | null>;
  record(
    status: W5RecoveryStatus,
    diagnosis?: W5Diagnosis,
    results?: readonly W5MaintenanceDecisionResult[],
  ): Promise<void>;
  readonly allowReservationRelease: boolean;
}

export function recoveryActions(
  diagnosis: W5Diagnosis,
  allowReservationRelease: boolean,
): readonly W5MaintenanceDecision[] {
  if (
    diagnosis.logIssue ||
    diagnosis.reservations.some((r) => r.state === 'reserved') ||
    diagnosis.commits.some((c) => c.state === 'committed')
  )
    return [];
  const decisions: W5MaintenanceDecision[] = [];
  for (const reservation of diagnosis.reservations)
    if (
      allowReservationRelease &&
      reservation.state === 'recovery-required' &&
      W5_RESOLVABLE_RESERVATION_OPERATIONS.has(reservation.operation)
    )
      decisions.push({
        kind: 'resolve-reservation',
        reservationId: reservation.reservationId,
      });
  for (const commit of diagnosis.commits) {
    if (commit.state !== 'recovery-required') continue;
    decisions.push({ kind: 'retry-commit', commitId: commit.commitId });
    if (
      commit.receiptOperations.length === 0 ||
      (allowReservationRelease &&
        [commit.operation, ...commit.receiptOperations].every((op) =>
          W5_RESOLVABLE_RESERVATION_OPERATIONS.has(op),
        ))
    )
      decisions.push({ kind: 'abandon-commit', commitId: commit.commitId });
  }
  return decisions;
}

export function w5DiagnosisEntries(diagnosis: W5Diagnosis): W5RecoveryEntry[] {
  const entries: W5RecoveryEntry[] = [
    ...diagnosis.reservations.map((r) => ({
      id: `reservation:${r.reservationId}`,
      operation: r.operation,
      detail: r.diagnostics,
    })),
    ...diagnosis.commits.map((c) => ({
      id: `commit:${c.commitId}`,
      operation: c.operation,
      detail: `Commit ${c.commitId}: ${c.state}. ${c.receiptOperations.length ? `Held keys: ${c.receiptOperations.join(', ')}. ` : ''}${c.diagnostics ?? ''}`,
    })),
  ];
  if (diagnosis.logIssue)
    entries.push({
      id: 'log',
      operation: 'Workspace records log',
      detail: diagnosis.logIssue,
    });
  if (diagnosis.destructiveJournalArtifactCount !== 0)
    entries.push({
      id: 'journals',
      operation: 'Interrupted archive or deletion',
      detail:
        diagnosis.destructiveJournalArtifactCount === null
          ? 'Journal inspection is unavailable. Keep the data folder intact and contact support.'
          : `${diagnosis.destructiveJournalArtifactCount} journal files need support. No destructive recovery runs here.`,
    });
  for (const file of diagnosis.files)
    if (
      file.reason === 'missing-file' ||
      file.reason === 'corrupt-file' ||
      file.reason === 'quarantined-journal'
    )
      entries.push({
        id: `file:${file.path}`,
        operation: file.path,
        detail: file.reason,
      });
  return entries.slice(0, 200).map((entry) => ({
    id: entry.id.slice(0, 256),
    operation: entry.operation.slice(0, 256),
    detail: entry.detail.slice(0, 2000),
  }));
}

/** Codes only; never publish an exception's message, paths or opaque details. */
export function w5RecoveryFailureReason(error: unknown): W5RecoveryReason {
  const seen = new Set<unknown>();
  const inspect = (
    error: unknown,
    depth: number,
  ): W5RecoveryReason | undefined => {
    if (depth > 8 || seen.has(error)) return undefined;
    seen.add(error);
    let direct: W5RecoveryReason | undefined;
    if (error instanceof W5MaintenanceRefusedError) direct = error.reason;
    if (
      error instanceof CanopyClientError &&
      error.payload.kind === 'cancelled'
    )
      direct = 'cancelled';
    const refusal = canopyDaemonRefusal(error);
    if (refusal === 'peer_held') direct = refusal;
    if (isRecord(error)) {
      const parsed = W5RecoveryReasonSchema.safeParse(error.reason);
      if (parsed.success) direct = parsed.data;
      if (error.name === 'AbortError') direct = 'cancelled';
      const nested: unknown[] = [
        error.failure,
        error.operationError,
        error.cause,
      ];
      if (Array.isArray(error.errors))
        for (const child of error.errors) nested.push(child);
      for (const child of nested) {
        const found = inspect(child, depth + 1);
        if (
          found === 'release-uncertain' ||
          found === 'writer-exit-unconfirmed'
        )
          return found;
        direct ??= found;
      }
    }
    return direct;
  };
  return inspect(error, 0) ?? 'unexpected';
}

function statusFor(
  diagnosis: W5Diagnosis,
  allowReservationRelease: boolean,
): W5RecoveryStatus {
  const entries = w5DiagnosisEntries(diagnosis);
  if (!entries.length) return { state: 'complete', canRecover: false, entries };
  const sourceUnavailable = diagnosis.files.some(
    (file) => file.reason === 'missing-file' || file.reason === 'corrupt-file',
  );
  const excluded =
    diagnosis.destructiveJournalArtifactCount !== 0 ||
    diagnosis.reservations.some(
      (r) => !W5_RESOLVABLE_RESERVATION_OPERATIONS.has(r.operation),
    );
  const historical =
    !allowReservationRelease &&
    diagnosis.reservations.some((r) =>
      W5_RESOLVABLE_RESERVATION_OPERATIONS.has(r.operation),
    );
  const pending =
    diagnosis.reservations.some((r) => r.state === 'reserved') ||
    diagnosis.commits.some((c) => c.state === 'committed');
  return {
    state: 'blocked',
    canRecover: false,
    entries,
    reason: diagnosis.logIssue
      ? 'log-unavailable'
      : sourceUnavailable
        ? 'source-unavailable'
        : pending
          ? 'launch-recovery-pending'
          : excluded
            ? 'operation-excluded'
            : historical
              ? 'history-unproven'
              : 'recovery-required',
  };
}

/** No admission, normal startup or product writer may run until this settles. */
export async function runW5RecoveryLaunch(
  ports: W5RecoveryLaunchPorts,
): Promise<W5RecoveryStatus> {
  let diagnosis: W5Diagnosis | undefined;
  let status: W5RecoveryStatus;
  let results: readonly W5MaintenanceDecisionResult[] | undefined;
  try {
    await ports.waitForRelease();
    const reopened = await ports.maintenance({
      source: 'offline_maintenance',
      mode: 'reopen',
    });
    if (reopened.mode !== 'reopen')
      throw new W5MaintenanceRefusedError('invalid-state');
    diagnosis = reopened.diagnosis;
    const selected = await ports.choose(diagnosis);
    if (selected === null)
      status = {
        ...statusFor(diagnosis, ports.allowReservationRelease),
        reason: 'cancelled',
      };
    else if (selected.length === 0)
      status = statusFor(diagnosis, ports.allowReservationRelease);
    else {
      const decisions = readW5MaintenanceDecisions(selected);
      const allowed = recoveryActions(diagnosis, ports.allowReservationRelease);
      if (
        !decisions ||
        decisions.some(
          (d) => !allowed.some((a) => JSON.stringify(a) === JSON.stringify(d)),
        )
      )
        throw new W5MaintenanceRefusedError('operation-excluded');
      const resolved = await ports.maintenance({
        source: 'offline_maintenance',
        mode: 'resolve',
        decisions,
      });
      if (resolved.mode !== 'resolve')
        throw new W5MaintenanceRefusedError('invalid-state');
      diagnosis = resolved.diagnosis;
      results = resolved.results;
      status = statusFor(diagnosis, ports.allowReservationRelease);
    }
  } catch (error) {
    if (error instanceof W5MaintenanceDecisionError) {
      results = error.results;
      if (error.diagnosis) diagnosis = error.diagnosis;
    }
    status = {
      state: 'refused',
      canRecover: false,
      reason: w5RecoveryFailureReason(error),
      entries: diagnosis ? w5DiagnosisEntries(diagnosis) : [],
    };
  }
  try {
    if (results) await ports.record(status, diagnosis, results);
    else await ports.record(status, diagnosis);
  } catch {
    // Uncertain release must remain fatal even when the support record fails.
    if (
      status.reason !== 'release-uncertain' &&
      status.reason !== 'writer-exit-unconfirmed'
    )
      status = { ...status, state: 'refused', reason: 'result-unavailable' };
  }
  return status;
}
