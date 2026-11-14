import { W5CommitLogHost } from './commit-log-host';
import { W5_LAUNCH_HEAL_OPERATIONS } from './commit-log/apply-evidence';
import { w5CommitLogLocation } from './commit-log/data-root';
import {
  ensureW5ServiceHistory,
  type W5ServiceHistoryRelocation,
} from './service-history';

/** Every worker start remains protected through durable service-history publication. */
export function createW5DaemonCommitLogHost(options: {
  readonly canonicalDataRoot: string;
  readonly workerEntry: string;
  readonly confinementAddon?: string;
  readonly admission: () => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<unknown>;
  readonly serviceHistoryRelocation?: W5ServiceHistoryRelocation;
}): W5CommitLogHost {
  const {
    canonicalDataRoot,
    admission,
    syncDirectory,
    serviceHistoryRelocation,
  } = options;
  return new W5CommitLogHost({
    ...w5CommitLogLocation(canonicalDataRoot),
    dataRoot: canonicalDataRoot,
    healCleanConflictOperations: W5_LAUNCH_HEAL_OPERATIONS,
    workerEntry: options.workerEntry,
    confinementAddon: options.confinementAddon,
    startupTimeoutMs: 10_000,
    // Phase 7 allows 5 s: 2.5 s for the call, then 2 s for worker exit.
    shutdownTimeoutMs: 2_500,
    workerExitWaitMs: 2_000,
    admission: async (): Promise<void> => {
      await admission();
      await ensureW5ServiceHistory(
        canonicalDataRoot,
        syncDirectory,
        serviceHistoryRelocation,
      );
      await admission();
    },
  });
}
