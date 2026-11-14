import { W5CommitLogHost } from './commit-log-host';
import { W5_LAUNCH_HEAL_OPERATIONS } from './commit-log/apply-evidence';
import { w5CommitLogLocation } from './commit-log/data-root';
import {
  admitW5ColdHost,
  admitW5ColdHostRequest,
  W5ColdAuthorityRefusedError,
} from './cold-authority';
import type { W5ColdHostOptions } from './cold-host-composition';

/** Claim-qualified capture may recover committed changes, never ordinary writes. */
export function createW5BackupBootstrapHost(
  options: W5ColdHostOptions,
): W5CommitLogHost {
  const { dataRoot, admission } = options;
  const host: W5CommitLogHost = new W5CommitLogHost({
    ...w5CommitLogLocation(dataRoot),
    dataRoot,
    healCleanConflictOperations: W5_LAUNCH_HEAL_OPERATIONS,
    workerEntry: options.workerEntry,
    confinementAddon: options.confinementAddon,
    snapshotOnly: true,
    requestAdmission: async (request): Promise<void> => {
      await admission?.();
      await admitW5ColdHostRequest(host, dataRoot, request);
    },
    admission: async (): Promise<void> => {
      await admission?.();
      if (!(await admitW5ColdHost(host, dataRoot, ['backup-bootstrap'])))
        throw new W5ColdAuthorityRefusedError('authority-not-held');
    },
  });
  return host;
}
