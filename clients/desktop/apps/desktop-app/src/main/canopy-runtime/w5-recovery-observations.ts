import { CanopyClientError } from '@canopy/core-client';
import { CoreWorkspaceRecordsTargetSchema } from '@canopy/protocol/canopy-core';
import type { W5RecoveryEntry } from '@canopy/protocol/remote-control/shell';
import type {
  W5RecordPortCall,
  W5RecordRecoveryTarget,
} from '../lib/w5-daemon-record-store';
import { isRecord } from '../lib/type-guards';

export interface W5RecoveryObservations {
  result(call: W5RecordPortCall<unknown>, result: unknown): void;
  failure(error: unknown): void;
  entries(): readonly W5RecoveryEntry[];
  hasRecoverableCommit(commitIds: readonly number[]): boolean;
  withoutCompleted(
    entries: readonly W5RecoveryEntry[],
  ): readonly W5RecoveryEntry[];
}
const validId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const targetKey = (target: W5RecordRecoveryTarget): string =>
  `${target.kind}${'workspaceId' in target ? `:${target.workspaceId}` : ''}`;
function targetName(target: W5RecordRecoveryTarget): string {
  switch (target.kind) {
    case 'index':
      return 'Workspace index';
    case 'index-backup':
      return 'Workspace index backup';
    case 'manifest':
      return `Workspace settings (${target.workspaceId})`;
    case 'worktrees':
      return `Task list (${target.workspaceId})`;
  }
}

/** Live refusals fill the gap in recovery.get's immutable launch-time report. */
export function createW5RecoveryObservations(): W5RecoveryObservations {
  const observed = new Map<
    number,
    { entry: W5RecoveryEntry; targets: readonly string[] }
  >();
  const completed = new Set<number>();
  const resolved = new Set<number>();
  const appliedByTarget = new Map<string, number>();
  const remember = (ids: Set<number>, id: number): void => {
    ids.add(id);
    if (ids.size > 200) {
      const oldest = ids.values().next();
      if (!oldest.done) ids.delete(oldest.value);
    }
  };
  const isCompleted = (id: number): boolean =>
    completed.has(id) || resolved.has(id);
  const note = (
    commitId: number,
    targets: readonly W5RecordRecoveryTarget[],
  ): void => {
    const previous = observed.get(commitId);
    // Commit IDs never repeat; late replies cannot undo proven completion.
    if (isCompleted(commitId)) return;
    if (
      targets.some(
        (target) => (appliedByTarget.get(targetKey(target)) ?? 0) > commitId,
      )
    ) {
      remember(resolved, commitId);
      return;
    }
    const knownTargets = targets.length ? targets : [];
    observed.set(commitId, {
      targets: knownTargets.length
        ? knownTargets.map(targetKey)
        : (previous?.targets ?? []),
      entry: {
        id: `commit:${commitId}`,
        operation: `Commit ${commitId}`,
        detail: knownTargets.length
          ? `${knownTargets.slice(0, 3).map(targetName).join(', ')} needs recovery. Operation details are available after restart.`
          : (previous?.entry.detail ??
            'This change needs recovery. Operation details are available after restart.'),
      },
    });
    if (observed.size > 200) {
      const oldest = observed.keys().next();
      if (!oldest.done) observed.delete(oldest.value);
    }
  };
  const complete = (id: number): void => {
    // Healthy traffic must not evict proof for previously displayed blockers.
    if (observed.delete(id)) remember(resolved, id);
    remember(completed, id);
  };
  const withoutCompleted = (
    entries: readonly W5RecoveryEntry[],
  ): readonly W5RecoveryEntry[] => {
    const ids = new Set(
      [...completed, ...resolved].map((id) => `commit:${id}`),
    );
    return entries.filter((entry) => !ids.has(entry.id));
  };
  return {
    result(call, result): void {
      if (!isRecord(result)) return;
      if (call.operation === 'core.workspaceRecords.recovery.get') {
        if (Array.isArray(result.recoveryRequired))
          for (const id of result.recoveryRequired)
            if (validId(id)) note(id, []);
        if (Array.isArray(result.applied))
          for (const id of result.applied) if (validId(id)) complete(id);
      }
      if (!validId(result.commitId)) return;
      if (
        result.status === 'recovery-required' ||
        result.status === 'commit-recovery-required'
      ) {
        note(result.commitId, call.recoveryTargets ?? []);
        return;
      }
      if (
        call.operation !== 'core.workspaceRecords.commit' ||
        (result.status !== 'applied' && result.status !== 'replayed')
      )
        return;
      complete(result.commitId);
      if (result.status !== 'applied') return;
      // Only a newer applied write proves an older fence ended; replay writes nothing.
      const written = new Set(call.recoveryTargets?.map(targetKey));
      for (const target of written) {
        appliedByTarget.set(
          target,
          Math.max(appliedByTarget.get(target) ?? 0, result.commitId),
        );
        if (appliedByTarget.size > 200) {
          const oldest = appliedByTarget.keys().next();
          if (!oldest.done) appliedByTarget.delete(oldest.value);
        }
      }
      for (const [id, entry] of observed)
        if (
          id < result.commitId &&
          entry.targets.some((target) => written.has(target))
        )
          complete(id);
    },
    failure(error): void {
      if (!(error instanceof CanopyClientError)) return;
      const { code, details } = error.payload;
      if (
        (code !== 'core.workspaceRecords.unappliedChange' &&
          code !== 'core.workspaceRecords.recoveryRequired') ||
        !isRecord(details) ||
        !validId(details.commitId)
      )
        return;
      const target = CoreWorkspaceRecordsTargetSchema.safeParse(details.target);
      note(details.commitId, target.success ? [target.data] : []);
    },
    entries: () => [...observed.values()].map(({ entry }) => ({ ...entry })),
    // Every observation is a recovery-required or unapplied commit, which launch
    // recovery applies or cold recovery retries.
    hasRecoverableCommit: (commitIds): boolean =>
      [...observed.keys(), ...commitIds].some(
        (id) => validId(id) && !isCompleted(id),
      ),
    withoutCompleted,
  };
}

export const electronW5RecoveryObservations: W5RecoveryObservations =
  createW5RecoveryObservations();
