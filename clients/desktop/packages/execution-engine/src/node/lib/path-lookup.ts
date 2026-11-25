import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { findExecutableOnPath as findOnPath } from '@canopy/core-platform/windows-shells';

export function findExecutableOnPath(
  name: string,
  pathEnv = process.env.PATH ?? '',
  options?: { rejectInvalid: boolean },
): string | null {
  return findOnPath(name, {
    os: hostOperatingSystem(),
    pathEnv,
    ...options,
    ...(process.env.PATHEXT !== undefined && { pathExt: process.env.PATHEXT }),
  });
}
