import type {
  PlatformOperatingSystem,
  PlatformSecureFileServices,
} from '@canopy/core-runtime';
import { setTimeout as sleep } from 'node:timers/promises';
import { probeDarwinAcl, type DarwinAclProbe } from './darwin-acl';
import { posixPermissions } from './posix-permissions';
import * as files from './rename';
import { errorCode, fail } from './shared';
import { readWindowsAcl, windowsPermissions } from './windows-acl';

export type { SecureFileErrorCode } from './shared';

/** Test seams only; production composition passes none. */
export interface SecureFileServiceOptions {
  readonly operations?: Partial<files.SecureFileOperations>;
  readonly retry?: Partial<files.RetryPolicy>;
  readonly darwinAcl?: DarwinAclProbe;
  readonly getuid?: () => number | undefined;
  readonly readWindowsAcl?: (target: string) => Promise<string>;
}

/** Only `private` permits use; failures to prove it are reported, not thrown. */
export function createSecureFileServices(
  os: PlatformOperatingSystem,
  options: SecureFileServiceOptions = {},
): PlatformSecureFileServices {
  const windows = os === 'win32';
  const ops = {
    ...(windows ? files.WINDOWS_OPERATIONS : files.NODE_OPERATIONS),
    ...options.operations,
  };
  const policy: files.RetryPolicy = {
    // 10 Windows tries ride out about 2.25 s of scanner locks.
    attempts: windows ? 10 : 1,
    delay: sleep,
    ...options.retry,
  };
  const getuid =
    options.getuid ?? ((): number | undefined => process.getuid?.());
  const readAcl = options.readWindowsAcl ?? readWindowsAcl;
  const services: PlatformSecureFileServices = {
    permissionModel: windows ? 'windows-dacl' : 'posix-mode',
    permissions: async (request) => {
      try {
        return windows
          ? await windowsPermissions(request, readAcl)
          : await posixPermissions(
              request,
              getuid(),
              os === 'darwin' ? (options.darwinAcl ?? probeDarwinAcl) : null,
            );
      } catch (error) {
        const code = errorCode(error) ?? 'error';
        return fail('unverifiable', `check failed: ${code}`, 'unverifiable');
      }
    },
    rename: (request) =>
      files.renameRegularFile(request, ops, policy, !windows),
    syncDirectory: (target) => files.syncDirectory(target, ops),
  };
  return Object.freeze(services);
}
