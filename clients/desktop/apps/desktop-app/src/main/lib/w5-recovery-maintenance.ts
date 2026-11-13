import { join } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import {
  isW5MaintenanceHostHeld,
  W5MaintenanceRefusedError,
  type W5MaintenanceContext,
} from './w5-maintenance';

/** Cold composition shared by recovery launches; never joins the host cohort. */
export function createW5RecoveryMaintenanceContext(
  dataRoot: string,
  options: {
    readonly workerEntry?: string;
    readonly admission?: () => Promise<void>;
    readonly windowsProcessPath?: string;
    readonly confinementAddon?: string;
    /** Not general Windows maintenance admission; reopen-only migration. */
    readonly offlineMigration?: () => Promise<void>;
  } = {},
): W5MaintenanceContext {
  const platform = hostPlatformServices(
    createPlatformEndpointServices(hostPlatformOperatingSystem()),
    { windowsProcessPath: options.windowsProcessPath },
  );
  const host: W5CommitLogHost = new W5CommitLogHost({
    dataRoot,
    root: join(dataRoot, 'workspaces'),
    dbPath: join(dataRoot, 'w5/commit-log.sqlite'),
    confinementAddon: options.confinementAddon,
    workerEntry:
      options.workerEntry ?? join(__dirname, 'w5-commit-log-worker.js'),
    admission: async (): Promise<void> => {
      await options.admission?.();
      if (!(await isW5MaintenanceHostHeld(host, dataRoot)))
        throw new W5MaintenanceRefusedError('claim-lost');
    },
  });
  return {
    dataRoot,
    platform,
    host,
    offlineMigration: options.offlineMigration,
  };
}
