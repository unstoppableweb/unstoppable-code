import { isSea } from 'node:sea';
import { win32, type PlatformPath } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { DAEMON_W5_CONFINEMENT_ADDON_FILE } from './w5-worker-file';

/** Shared without eagerly loading the opt-in W5 host graph. */
export interface DaemonLocation {
  readonly isSea: boolean;
  readonly execPath: string;
  readonly argv1: string | undefined;
}

export const daemonHostLocation = (): DaemonLocation => ({
  isSea: isSea(),
  execPath: process.execPath,
  argv1: process.argv[1],
});

/** The executable's folder, or the entry script's in a bundled run. */
export const companionDirectory = (
  paths: PlatformPath,
  location: DaemonLocation,
): string =>
  location.isSea
    ? paths.dirname(location.execPath)
    : paths.dirname(paths.resolve(location.argv1 ?? ''));

/** win32: the fully qualified owned-child addon beside the daemon; absent elsewhere. */
export function daemonOwnedChildAddon(
  os: PlatformOperatingSystem | null = hostOperatingSystem(),
  location = daemonHostLocation(),
): string | undefined {
  if (os !== 'win32') return undefined;
  return win32.join(
    companionDirectory(win32, location),
    DAEMON_W5_CONFINEMENT_ADDON_FILE,
  );
}
