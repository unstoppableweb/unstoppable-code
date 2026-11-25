import type { PlatformOperatingSystem } from '../../platform/platform-services';

const directoryIdentity =
  /^(\d+):(\d+):(-?\d+(?:\.\d+)?)(?::([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}))?$/i;

/**
 * A volume's device number can change across reboots and remounts on macOS
 * (APFS renumbering) and Linux (btrfs gives each subvolume an anonymous
 * device at mount). There a device-only difference matches when the inode,
 * birth time and any incarnation marker match. Linux also needs a real birth
 * time: without one the inode alone would vouch for the directory. Windows
 * volume serial numbers stay exact.
 */
function toleratesDeviceDrift(
  operatingSystem: PlatformOperatingSystem | null,
  birthtimeMs: string,
): boolean {
  return (
    operatingSystem === 'darwin' ||
    (operatingSystem === 'linux' && Number(birthtimeMs) !== 0)
  );
}

/** Persisted evidence only. Current-attempt observations and worker bindings stay exact. */
export function matchesRecordedDirectoryIdentity(
  recorded: string | null | undefined,
  live: string | null | undefined,
  operatingSystem: PlatformOperatingSystem | null,
): boolean {
  if (typeof recorded !== 'string' || typeof live !== 'string') return false;
  const saved = directoryIdentity.exec(recorded);
  const observed = directoryIdentity.exec(live);
  return (
    saved !== null &&
    observed !== null &&
    saved[0] === recorded &&
    observed[0] === live &&
    (saved[1] === observed[1] ||
      toleratesDeviceDrift(operatingSystem, saved[3])) &&
    saved[2] === observed[2] &&
    saved[3] === observed[3] &&
    (saved[4] === undefined || saved[4] === observed[4])
  );
}

export function directoryStatIdentity(identity: {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}): string {
  return `${identity.dev}:${identity.ino}:${identity.birthtimeMs}`;
}

/** Repository paths can contain colons; only the last three fields are stat evidence. */
export function matchesRecordedRepositoryIdentity(
  recorded: string,
  live: string,
  operatingSystem: PlatformOperatingSystem | null,
): boolean {
  const saved = recorded.split(':');
  const observed = live.split(':');
  return (
    saved.length >= 4 &&
    observed.length >= 4 &&
    saved.slice(0, -3).join(':') === observed.slice(0, -3).join(':') &&
    matchesRecordedDirectoryIdentity(
      saved.slice(-3).join(':'),
      observed.slice(-3).join(':'),
      operatingSystem,
    )
  );
}
