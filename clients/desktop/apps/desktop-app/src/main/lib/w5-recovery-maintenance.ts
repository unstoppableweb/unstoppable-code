import { join } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { createCanopyStartupClaimPort } from '@canopy/core-transport/node';
import { createW5MaintenanceHost } from '@canopy/core-runtime/node/w5/cold-host-composition';
import type { W5MaintenanceContext } from './w5-maintenance';

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
    createPlatformEndpointServices(hostPlatformOperatingSystem(), {
      validateStartupClaim: async (claim): Promise<boolean> => {
        const self = await platform.supervision.inspectProcess({
          pid: process.pid,
        });
        if (self.state !== 'running' || claim.dataRoot !== dataRoot)
          return false;
        const claims = createCanopyStartupClaimPort({
          dataRoot,
          owner: { pid: process.pid, startIdentity: self.startIdentity },
          inspectProcess: async (pid, signal) => {
            const found = await platform.supervision.inspectProcess({
              pid,
              signal,
            });
            return found.state === 'running'
              ? { kind: 'alive', startIdentity: found.startIdentity }
              : { kind: found.state === 'absent' ? 'dead' : 'unknown' };
          },
        });
        return claims.verify(claim);
      },
    }),
    { windowsProcessPath: options.windowsProcessPath },
  );
  const host = createW5MaintenanceHost({
    dataRoot,
    confinementAddon: options.confinementAddon,
    workerEntry:
      options.workerEntry ?? join(__dirname, 'w5-commit-log-worker.js'),
    admission: options.admission,
  });
  return {
    dataRoot,
    platform,
    host,
    offlineMigration: options.offlineMigration,
  };
}
