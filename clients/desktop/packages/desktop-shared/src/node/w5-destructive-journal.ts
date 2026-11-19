export {
  archiveTriggerSchema,
  journalSchema,
  type ArchiveTrigger,
  type DestructiveRecoveryRecord,
} from '@canopy/protocol/portal/lifecycle-journal';
import {
  inspectDestructiveJournals as inspectCoreDestructiveJournals,
  readDestructiveJournal as readCoreDestructiveJournal,
  type DestructiveJournalInspection,
} from '@canopy/core-runtime/node/w5/destructive-journal';
import type { DestructiveRecoveryRecord } from '@canopy/protocol/portal/lifecycle-journal';
export type { DestructiveJournalInspection } from '@canopy/core-runtime/node/w5/destructive-journal';

export function readDestructiveJournal(
  path: string,
): Promise<DestructiveRecoveryRecord> {
  return readCoreDestructiveJournal(path);
}

export function inspectDestructiveJournals(
  dataRoot: string,
): Promise<DestructiveJournalInspection> {
  return inspectCoreDestructiveJournals(dataRoot);
}

export function isArchiveCleanupPhase(phase: string): boolean {
  return (
    phase.startsWith('sidecar:') ||
    [
      'live-state-teardown',
      'turn-diff-cleanup',
      'browser-retirement',
      'sidecar-cleanup',
      'compatibility-symlinks',
      'canonical-row-removal',
      'deferred-browser-retirement',
      'watcher-commit',
      'temporary-workspace-cleanup',
    ].includes(phase)
  );
}
