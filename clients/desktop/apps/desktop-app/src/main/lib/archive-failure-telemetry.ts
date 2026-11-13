import { AsyncLocalStorage } from 'node:async_hooks';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { getCanopyBuildIdentity } from '@canopy/execution-engine/canopy-paths';
import {
  archiveTriggerSchema,
  type ArchiveTrigger,
  type DestructiveRecoveryRecord,
} from '@canopy/desktop-shared/node/w5-destructive-journal';
import { WorkspaceTargetAutoArchiveExcludedError } from './workspace-target-exclusion';
import type { DesktopInstrumentationContext } from '@canopy/desktop-instrumentation';
import { captureDesktopInstrumentationError } from '@canopy/desktop-instrumentation/electron/main';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { W5RevisionConflictError } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import type { WorktreeDiscardDescription } from '@canopy/protocol/portal';
import {
  destructiveFailureCode,
  destructiveFailureRecord,
  destructiveJournalDiagnostic,
} from './destructive-failure-context';
import { WorkspaceDeletionRefusedError } from './workspace-deletion-refusal';
import { WorktreeArchiveRefusedError } from './worktree-archive-refusal';
import { logMainProcessWarn } from './main-process-logging';

export type { ArchiveTrigger } from '@canopy/desktop-shared/node/w5-destructive-journal';
export interface ArchiveFailureTelemetryOptions {
  telemetryParent: 'inherit';
}

interface ArchiveFailureContext {
  closed: boolean;
  phase: string;
  trigger: ArchiveTrigger;
  target: () => ArchiveFailureTarget;
  report: ArchiveFailureReport;
}
interface ArchiveFailureReport {
  closed: boolean;
  trigger: ArchiveTrigger;
  failure?: { error: unknown; phase: string; trigger: ArchiveTrigger };
  failureTargets: Map<
    unknown,
    { target: ArchiveFailureTarget; phase: string; trigger: ArchiveTrigger }
  >;
  discard?: WorktreeDiscardDescription | null;
  discardOffered: boolean;
}
const context = new AsyncLocalStorage<ArchiveFailureContext>();

interface ArchiveFailureTarget {
  workspaceId?: string;
  worktreeId?: string;
  expectedCreatedAt?: string;
  archiveTrigger?: ArchiveTrigger;
}

const checks = new Set([
  'destructive-lifecycle-state',
  'journal-slot-identity',
  'stranded-journal-scan',
  'stranded-journal-rescan',
  'assert-archive-cleanup-recovery',
  'child-archive-resumable',
  'destructive-lifecycle-admission',
  'check-identity',
  'launch-stranded-journal-scan',
  'unreadable-entry',
  'journal-directory-unreadable',
  'legacy-journal-unreadable',
  'legacy-journal',
  'staged-git-capture',
  'row-list-not-authoritative',
  'manifest-absent',
  'manifest-unreadable',
  'manifest-kind',
  'manifest-created-at-mismatch',
  'expected-created-at-mismatch',
  'row-created-at-mismatch',
  'row-removal-not-journaled',
]);

const archivePhases = new Set([
  'admission',
  'project-cleanup',
  'teardown-script',
  'resource-drain',
  'git-capture',
  'file-recovery',
  'teardown',
  'commit-cleanup',
]);

export function setArchiveFailurePhase(phase: string): void {
  const active = context.getStore();
  if (active && !active.closed && !active.report.closed) active.phase = phase;
}

/** A typed refusal resolves, but it still belongs in the failure count. */
export function recordArchiveRefusal(
  error: unknown,
  discard: WorktreeDiscardDescription | null,
  offered: boolean,
): void {
  const scope = context.getStore();
  if (!scope || scope.closed || scope.report.closed) return;
  const active = scope.report;
  active.failure = {
    error,
    phase: active.failureTargets.get(error)?.phase ?? scope.phase,
    trigger: active.failureTargets.get(error)?.trigger ?? scope.trigger,
  };
  active.discard = discard;
  active.discardOffered = offered;
}

export async function withArchiveFailureTelemetry<T>(
  target: ArchiveFailureTarget | (() => ArchiveFailureTarget),
  run: () => Promise<T>,
  options?: ArchiveFailureTelemetryOptions,
): Promise<T> {
  // Async ancestry alone does not grant ownership of a background operation.
  const ambient = context.getStore();
  const parent =
    options?.telemetryParent === 'inherit' &&
    ambient &&
    !ambient.closed &&
    !ambient.report.closed
      ? ambient
      : undefined;
  const resolveTarget = (): ArchiveFailureTarget => {
    const addressed = typeof target === 'function' ? target() : target;
    if (addressed.expectedCreatedAt !== undefined || !parent) return addressed;
    const inherited = parent.target();
    return addressed.workspaceId === inherited.workspaceId &&
      addressed.worktreeId !== undefined &&
      addressed.worktreeId === inherited.worktreeId
      ? { ...addressed, expectedCreatedAt: inherited.expectedCreatedAt }
      : addressed;
  };
  const trigger = archiveTriggerSchema.safeParse(
    resolveTarget().archiveTrigger,
  ).data;
  if (parent) {
    const active = parent.report;
    const child: ArchiveFailureContext = {
      closed: false,
      phase: 'admission',
      trigger: trigger ?? parent.trigger,
      target: resolveTarget,
      report: active,
    };
    return context.run(child, async () => {
      try {
        return await run();
      } catch (error) {
        // Keep each innermost failure even when sibling scopes overlap.
        if (
          !child.closed &&
          !active.closed &&
          !active.failureTargets.has(error)
        )
          active.failureTargets.set(error, {
            target: resolveTarget(),
            phase: child.phase,
            trigger: child.trigger,
          });
        throw error;
      } finally {
        child.closed = true;
      }
    });
  }
  const active: ArchiveFailureReport = {
    closed: false,
    trigger: trigger ?? 'manual',
    failureTargets: new Map(),
    discardOffered: false,
  };
  const scope: ArchiveFailureContext = {
    closed: false,
    phase: 'admission',
    trigger: active.trigger,
    target: resolveTarget,
    report: active,
  };
  return context.run(scope, async () => {
    try {
      return await run();
    } catch (error) {
      if (!active.failure || active.failure.error !== error) {
        delete active.discard;
        active.discardOffered = false;
        active.failure = {
          error,
          phase: active.failureTargets.get(error)?.phase ?? scope.phase,
          trigger: active.failureTargets.get(error)?.trigger ?? scope.trigger,
        };
      }
      throw error;
    } finally {
      scope.closed = true;
      active.closed = true;
      if (
        active.failure &&
        !(
          active.failure.error instanceof
          WorkspaceTargetAutoArchiveExcludedError
        )
      ) {
        // Reporting and read-only inspection must never replace the original result.
        try {
          const error = active.failure.error;
          const addressed =
            active.failureTargets.get(error)?.target ?? resolveTarget();
          let record = destructiveFailureRecord(error);
          if (!record && addressed.workspaceId !== undefined) {
            const { readDestructiveRecovery } =
              await import('./w5-destructive-recovery');
            const candidate = await readDestructiveRecovery(
              addressed.workspaceId,
              addressed.worktreeId,
            ).catch(() => null);
            // Slots outlive completed operations and can belong to a reused ID.
            if (candidate?.createdAt && candidate.state !== 'completed') {
              let createdAt = addressed.expectedCreatedAt;
              if (
                createdAt === undefined &&
                addressed.worktreeId !== undefined
              ) {
                const { readWorkspaceWorktreesUnlocked } =
                  await import('./workspace-persistence');
                // Inspection may inherit a closed commit scope or a held list lock.
                const list = await readWorkspaceWorktreesUnlocked(
                  addressed.workspaceId,
                ).catch(() => null);
                const rows = list?.worktrees.filter(
                  (row) => row.id === addressed.worktreeId,
                );
                if (list?.authority === 'ok' && rows?.length === 1)
                  createdAt = rows[0]?.createdAt;
              }
              if (createdAt && candidate.createdAt === createdAt)
                record = candidate;
            }
          }
          const inspectionTarget = record?.worktreeId ? record : addressed;
          if (
            active.discard === undefined &&
            inspectionTarget.workspaceId !== undefined &&
            inspectionTarget.worktreeId !== undefined
          ) {
            const { describeWorktreeDiscard } =
              await import('./worktree-discard');
            active.discard = await describeWorktreeDiscard(
              inspectionTarget.workspaceId,
              inspectionTarget.worktreeId,
            ).catch(() => null);
          }
          const diagnostic = buildArchiveFailureDiagnostic(
            error,
            {
              ...active,
              phase: active.failure.phase,
              trigger: active.failure.trigger,
            },
            record,
          );
          logMainProcessWarn('Worktree archive failed', diagnostic);
          // Only fixed classifications and the journal UUID reach the existing sanitizer.
          captureDesktopInstrumentationError(
            new Error('Worktree archive failed'),
            { context: diagnostic },
          );
        } catch {
          // Telemetry is best effort, independent of archive/refusal delivery.
        }
      }
    }
  });
}

const refusalReasons = new Set([
  'identity-conflict',
  'revision-conflict',
  'key-reused',
  'outcome-expired',
  'in-progress',
  'recovery-required',
  'unapplied-change',
  'unknown-reservation',
  'invalid-state',
  'unsupported-workspace',
  'kind-mismatch',
  'not-found',
  'busy',
  'source-unavailable',
  'protected',
  'configuration-unavailable',
  'not-single-repo',
  'not-cowork',
  'git-cleanup-pending',
  'archive-recovery-unverified',
  'archive-in-progress',
]);
function safeRefusalReason(reason: string): string {
  return refusalReasons.has(reason) ? reason : 'unknown';
}

const discardRefusalReasons = new Set([
  'not-found',
  'read-only-scope',
  'forbidden',
  'list-unreadable',
  'configuration-unreadable',
  'unsupported-workspace',
  'project-deletion-pending',
  'other-incarnation',
  'no-broken-removal',
  'retry-available',
  'source-unverified',
  'evidence-mismatch',
  'evidence-unreadable',
  'unverifiable-target',
  'retained-archive',
  'busy',
]);

export function buildArchiveFailureDiagnostic(
  error: unknown,
  scope: Pick<
    ArchiveFailureReport,
    'trigger' | 'discard' | 'discardOffered'
  > & { phase: string },
  record?: DestructiveRecoveryRecord,
): DesktopInstrumentationContext {
  const refusal =
    error instanceof W5CommitRefusedError ||
    error instanceof W5RevisionConflictError ||
    error instanceof WorktreeArchiveRefusedError ||
    error instanceof WorkspaceDeletionRefusedError;
  const details = error instanceof W5CommitRefusedError ? error.details : {};
  return {
    ...destructiveJournalDiagnostic(record),
    archive_trigger: record
      ? (archiveTriggerSchema.safeParse(record.trigger).data ?? 'unknown')
      : (archiveTriggerSchema.safeParse(scope.trigger).data ?? 'unknown'),
    request_trigger:
      archiveTriggerSchema.safeParse(scope.trigger).data ?? 'unknown',
    build_channel: getCanopyBuildIdentity().build,
    phase: archivePhases.has(scope.phase) ? scope.phase : 'unknown',
    code: destructiveFailureCode(error),
    refusal_reason: refusal ? safeRefusalReason(error.reason) : 'none',
    refusal_phase:
      details.phase === 'archive-journal' ||
      details.phase === 'lifecycle-journal' ||
      details.phase === 'destructive-lifecycle' ||
      details.phase === 'unrecorded-checkout'
        ? details.phase
        : refusal
          ? 'admission'
          : 'not-applicable',
    refusal_check:
      typeof details.check === 'string' && checks.has(details.check)
        ? details.check
        : refusal
          ? 'archive-admission'
          : 'not-applicable',
    discard_status:
      scope.discard?.status === 'discardable' ||
      scope.discard?.status === 'refused'
        ? scope.discard.status
        : 'unreadable',
    discard_refusal_reason: scope.discard?.refusal
      ? discardRefusalReasons.has(scope.discard.refusal.reason)
        ? scope.discard.refusal.reason
        : 'unknown'
      : 'none',
    is_discard_offered: scope.discardOffered,
    platform: hostOperatingSystem() ?? 'unknown',
  };
}
