import { W5CommitLogHost } from './commit-log-host';
import { w5CommitLogLocation } from './commit-log/data-root';
import {
  admitW5ColdHost,
  admitW5ColdHostRequest,
  W5ColdAuthorityRefusedError,
} from './cold-authority';

export interface W5ColdHostOptions {
  readonly dataRoot: string;
  readonly workerEntry: string;
  readonly confinementAddon?: string;
  /** Additional trusted host checks cannot replace the core capability. */
  readonly admission?: () => Promise<void>;
}

/** Diagnosis never starts a worker; only admitted maintenance can recover/write. */
export function createW5MaintenanceHost(
  options: W5ColdHostOptions,
): W5CommitLogHost {
  const { dataRoot, admission } = options;
  const host: W5CommitLogHost = new W5CommitLogHost({
    ...w5CommitLogLocation(dataRoot),
    dataRoot,
    workerEntry: options.workerEntry,
    confinementAddon: options.confinementAddon,
    requestAdmission: async (request): Promise<void> => {
      await admission?.();
      await admitW5ColdHostRequest(host, dataRoot, request);
    },
    admission: async (): Promise<void> => {
      await admission?.();
      if (
        !(await admitW5ColdHost(host, dataRoot, [
          'reopen',
          'resolve',
          'restore',
        ]))
      )
        throw new W5ColdAuthorityRefusedError('authority-not-held');
    },
  });
  return host;
}
