import { createNativeTrashServices } from '@canopy/core-platform';
import type {
  PlatformOperatingSystem,
  PlatformTrashServices,
} from '@canopy/core-runtime';
import { daemonOwnedChildAddon, type DaemonLocation } from './companion-paths';

/** The daemon's host option, using only its staged companion on Windows. */
export function createDaemonTrashServices(
  os: PlatformOperatingSystem,
  location?: DaemonLocation,
): PlatformTrashServices {
  const ownedChildPath = daemonOwnedChildAddon(os, location);
  return createNativeTrashServices(os, {
    ...(ownedChildPath !== undefined && { ownedChildPath }),
  });
}
