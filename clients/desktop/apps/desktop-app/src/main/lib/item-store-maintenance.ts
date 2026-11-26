import { readdir, readFile } from 'node:fs/promises';
import { BRAND } from '@canopy/brand/current';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { acquireW5RootPresence } from '@canopy/core-platform/w5-root-presence';
import {
  ExclusiveMaintenanceRefusedError,
  withExclusiveOfflineMaintenance,
  type ExclusiveMaintenanceOptions,
  type OfflineReadPort,
} from '@canopy/core-runtime/node/maintenance/exclusive-window';
import {
  createItemStoreQuiesce,
  ItemStoreMaintenanceRefusedError,
} from '@canopy/core-runtime/node/maintenance/item-store-quiesce';
import {
  createItemStoreMaintenanceTargets,
  type ItemStoreDiagnosis,
  type ItemStoreMaintenanceTarget,
} from '@canopy/core-runtime/node/maintenance/item-store-targets';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupClaimPort,
} from '@canopy/core-transport/node';
import { hasJoinedW5RootPresence } from '@canopy/desktop-shared/node/w5-root-presence';
import {
  acquireW5MaintenanceExclusion,
  listW5HostPeers,
} from '@canopy/execution-engine/node/w5-host-cohort';
import { isErrnoException } from './type-guards';

/*
 * CAN-4498: Electron's composition of the exclusive offline window over the
 * six item stores. Callable only before admitDesktopW5Host joins root
 * presence; the window refuses `caller-admitted` otherwise. No production
 * caller yet: CAN-4735 PR 7 places the call in the pre-admission launch slot.
 */

/** Read-only. A path through a file reads as absent, like a missing one. */
const offlineRead: OfflineReadPort = {
  readFile: async (path) => {
    try {
      return await readFile(path);
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
  },
  readDirectory: async (path) => {
    try {
      return await readdir(path);
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
  },
};

function isAbsent(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function refused(
  reason: 'platform-unsupported' | 'identity-unprovable',
  cause?: unknown,
): ItemStoreMaintenanceRefusedError {
  return new ItemStoreMaintenanceRefusedError(
    new ExclusiveMaintenanceRefusedError(reason, { cause }),
  );
}

/** The window's options for this canonical data root. */
export async function electronItemStoreMaintenanceOptions(
  dataRoot: string,
  options: { readonly mutating: boolean; readonly signal?: AbortSignal },
): Promise<
  ExclusiveMaintenanceOptions & {
    readonly targets: readonly ItemStoreMaintenanceTarget[];
  }
> {
  const os = hostPlatformOperatingSystem();
  if (os === 'win32') throw refused('platform-unsupported');
  const claimPort: { current?: CanopyStartupClaimPort } = {};
  const platform = hostPlatformServices(
    createPlatformEndpointServices(os, {
      validateStartupClaim: (claim) =>
        claimPort.current?.verify(claim) ?? Promise.resolve(false),
    }),
  );
  const self = await platform.supervision
    .inspectProcess({ pid: process.pid, signal: options.signal })
    .catch((error: unknown) => {
      throw refused('identity-unprovable', error);
    });
  if (self.state !== 'running') throw refused('identity-unprovable');
  const claims = createCanopyStartupClaimPort({
    dataRoot,
    owner: { pid: process.pid, startIdentity: self.startIdentity },
    inspectProcess: async (pid, signal) => {
      const found = await platform.supervision.inspectProcess({ pid, signal });
      return found.state === 'running'
        ? { kind: 'alive', startIdentity: found.startIdentity }
        : { kind: found.state === 'absent' ? 'dead' : 'unknown' };
    },
  });
  claimPort.current = claims;
  return {
    dataRoot,
    os,
    mutating: options.mutating,
    signal: options.signal,
    targets: createItemStoreMaintenanceTargets({
      dataRoot,
      coworkDirNames: BRAND.storage.projectConfigDirNames,
    }),
    deps: {
      claims,
      platform,
      read: offlineRead,
      callerJoinedPresence: hasJoinedW5RootPresence,
      acquirePresence: (root) => acquireW5RootPresence(root, 'maintenance'),
      acquireExclusion: acquireW5MaintenanceExclusion,
      listHostPeers: () =>
        listW5HostPeers({
          dataRoot,
          secureFiles: platform.secureFiles,
          inspect: (pid, signal) =>
            platform.supervision.inspectProcess({ pid, signal }),
        }),
    },
  };
}

/** CAN-5340's `quiesce` for the backup and restore families, one window per call. */
export function createElectronItemStoreQuiesce(
  dataRoot: string,
  options: { readonly mutating: boolean; readonly signal?: AbortSignal },
): <T>(op: () => Promise<T>) => Promise<T> {
  return async <T>(op: () => Promise<T>): Promise<T> => {
    const quiesce = createItemStoreQuiesce(
      await electronItemStoreMaintenanceOptions(dataRoot, options),
    );
    return quiesce(op);
  };
}

/** Read-only `diagnose` of every held root, in a read-only window. */
export async function diagnoseElectronItemStores(
  dataRoot: string,
  signal?: AbortSignal,
): Promise<readonly ItemStoreDiagnosis[]> {
  const options = await electronItemStoreMaintenanceOptions(dataRoot, {
    mutating: false,
    signal,
  });
  const targets: readonly ItemStoreMaintenanceTarget[] = options.targets;
  try {
    return await withExclusiveOfflineMaintenance(options, async (window) => {
      const results: ItemStoreDiagnosis[] = [];
      for (const root of window.roots) {
        const target = targets.find((entry) => entry.key === root.key);
        if (!target) continue;
        results.push(await target.diagnose(offlineRead, root, window.signal));
        await window.assertHeld();
      }
      return results;
    });
  } catch (error) {
    if (
      error instanceof ExclusiveMaintenanceRefusedError &&
      !(error instanceof ItemStoreMaintenanceRefusedError)
    )
      throw new ItemStoreMaintenanceRefusedError(error);
    throw error;
  }
}
