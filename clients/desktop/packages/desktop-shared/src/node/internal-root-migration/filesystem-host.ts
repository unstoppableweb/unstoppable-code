import { constants, type Stats } from 'node:fs';
import {
  copyFile,
  lchown,
  lstat,
  lutimes,
  mkdir,
  open,
  readdir,
  readlink,
  statfs,
  symlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  createWindowsMigrationFilesystem,
  isWindowsMigrationStreamError,
  loadMigrationRenameNoReplace,
  type WindowsMigrationFilesystem,
  type MigrationFilesystemObservation,
} from '@canopy/core-platform/internal-migration-filesystem';
import {
  InternalRootMigrationRefused,
  type InternalRootSpace,
} from '@canopy/core-runtime/node/internal-root-migration';
import { internalRootMigrationProgress } from './progress';

export async function internalRootCopySpace(
  destination: string,
  sourceBytes: number,
): Promise<InternalRootSpace> {
  const volume = await statfs(dirname(destination));
  return {
    // APFS clones share payload blocks; reserve 64 MiB for construction metadata.
    requiredBytes:
      hostOperatingSystem() === 'darwin' && volume.type === 26
        ? 64 * 1024 * 1024
        : sourceBytes,
    availableBytes: volume.bavail * volume.bsize,
  };
}

export interface InternalRootFilesystemHost {
  readonly windows?: WindowsMigrationFilesystem;
  readonly renameNoReplace?: (
    from: string,
    to: string,
    identity: string,
  ) => void;
}
export const DEFAULT_FILESYSTEM_HOST: InternalRootFilesystemHost =
  Object.freeze({});

export function internalRootFilesystemHost(
  ownedChildPath?: string,
): InternalRootFilesystemHost {
  if (ownedChildPath === undefined) return DEFAULT_FILESYSTEM_HOST;
  switch (hostOperatingSystem()) {
    case 'win32':
      return { windows: createWindowsMigrationFilesystem(ownedChildPath) };
    case 'linux':
      return { renameNoReplace: loadMigrationRenameNoReplace(ownedChildPath) };
    default:
      return DEFAULT_FILESYSTEM_HOST;
  }
}
function refuse(message: string): never {
  throw new InternalRootMigrationRefused('unsupported-layout', message);
}
export function windowsFilesystem(
  host: InternalRootFilesystemHost,
): WindowsMigrationFilesystem {
  if (!host.windows)
    refuse(
      'Windows filesystem custody is not installed. Apply remains unavailable until integration.',
    );
  return host.windows;
}
// Keep Darwin's numeric identity unchanged; Windows NTFS IDs exceed 2^53.
export async function migrationNodeIdentity(
  path: string,
  stat: Stats,
): Promise<string> {
  const exact =
    hostOperatingSystem() === 'win32'
      ? await lstat(path, { bigint: true })
      : stat;
  return `${exact.dev}:${exact.ino}`;
}

export async function observeMigrationNode(
  path: string,
  stat: Stats,
  host: InternalRootFilesystemHost,
): Promise<MigrationFilesystemObservation | null> {
  if (hostOperatingSystem() !== 'win32') return null;
  let observed: MigrationFilesystemObservation;
  try {
    observed = windowsFilesystem(host).inspect(path);
  } catch (error) {
    if (isWindowsMigrationStreamError(error))
      refuse(`${error.message} Preserve both trees and the journal.`);
    throw error;
  }
  const exact = await lstat(path, { bigint: true });
  if (
    BigInt(observed.dev) !== exact.dev ||
    observed.ino !== exact.ino ||
    observed.dev !== stat.dev
  )
    refuse(
      `Native filesystem identity ${observed.dev}:${observed.ino} disagrees with exact Stats ${exact.dev}:${exact.ino}. Preserve both trees.`,
    );
  return observed;
}
export function ownedMigrationNode(stat: Stats): boolean {
  return hostOperatingSystem() === 'win32' || stat.uid === process.getuid?.();
}
export function qualifyMigrationGroup(path: string, stat: Stats): void {
  if (
    hostOperatingSystem() === 'linux' &&
    !stat.isSocket() &&
    process.geteuid?.() !== 0 &&
    stat.gid !== process.getegid?.() &&
    !process.getgroups?.().includes(stat.gid)
  )
    refuse(
      `Source group ${stat.gid} cannot be assigned by this process: ${path}. Preserve both trees and the journal.`,
    );
}

async function restoreMigrationGroup(
  path: string,
  gid: number,
  assign: () => Promise<void>,
): Promise<void> {
  try {
    await assign();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    )
      refuse(
        `Source group ${gid} cannot be assigned during construction: ${path}. Preserve both trees and the journal.`,
      );
    throw error;
  }
}
export async function createPrivateMigrationDirectory(
  path: string,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  if (hostOperatingSystem() === 'win32') windowsFilesystem(host).mkdir(path);
  else await mkdir(path, { mode: 0o700 });
}

/** Explicitly qualified local Linux formats, not a generic network/ACL promise. */
export async function qualifyCopyVolume(
  source: string,
  destination: string,
): Promise<void> {
  const [from, parent, fs] = await Promise.all([
    lstat(source),
    lstat(dirname(destination)),
    statfs(source),
  ]);
  if (
    from.dev !== parent.dev ||
    ![0xef53, 0x58465342, 0x9123683e].includes(fs.type)
  )
    refuse(
      'Linux construction requires same-volume local ext4, XFS or Btrfs with SQLite locking, directory fsync and sibling rename.',
    );
}

/** Non-following construction, never a backup; source metadata is never changed. */
export async function copyInternalRootTree(
  source: string,
  destination: string,
  host: InternalRootFilesystemHost,
  rootExists = false,
  omitted: (relative: string) => boolean = () => false,
): Promise<void> {
  const windows = hostOperatingSystem() === 'win32';
  if (!windows) await qualifyCopyVolume(source, destination);
  const device = (await lstat(source)).dev;
  let entries = 0;
  async function visit(from: string, to: string, relative = ''): Promise<void> {
    if (omitted(relative)) return;
    const before = await lstat(from);
    if (before.dev !== device || !ownedMigrationNode(before))
      refuse(`Unsafe source tree entry: ${from}`);
    qualifyMigrationGroup(from, before);
    await observeMigrationNode(from, before, host);
    internalRootMigrationProgress('inspected copy source entry');
    const beforeIdentity = windows
      ? await migrationNodeIdentity(from, before)
      : null;
    if (before.isDirectory()) {
      if (!windows && (before.mode & 0o500) !== 0o500)
        refuse(
          `Source directory requires owner read and search access: ${from}`,
        );
      if (!(from === source && rootExists)) {
        if (windows) windowsFilesystem(host).copy(from, to);
        else await mkdir(to, { mode: 0o700 });
      }
      if (windows) {
        for (const name of (await readdir(from)).sort())
          await visit(join(from, name), join(to, name), join(relative, name));
        windowsFilesystem(host).finish(from, to);
      } else {
        const flags =
          constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_DIRECTORY |
          constants.O_NONBLOCK;
        const sourceHandle = await open(from, flags);
        try {
          const opened = await sourceHandle.stat();
          if (opened.dev !== before.dev || opened.ino !== before.ino)
            refuse(`Source directory replaced: ${from}`);
          const targetHandle = await open(to, flags);
          try {
            const created = await targetHandle.stat();
            const anchoredSource = `/proc/self/fd/${sourceHandle.fd}`;
            const anchoredTarget = `/proc/self/fd/${targetHandle.fd}`;
            for (const name of (await readdir(anchoredSource)).sort())
              await visit(
                join(anchoredSource, name),
                join(anchoredTarget, name),
                join(relative, name),
              );
            // chown can clear setuid/setgid; restore modes and times afterwards.
            await restoreMigrationGroup(to, before.gid, () =>
              targetHandle.chown(-1, before.gid),
            );
            await targetHandle.chmod(before.mode & 0o7777);
            await targetHandle.utimes(
              before.atimeMs / 1000,
              manifestTimestamp(before.mtimeMs),
            );
            const current = await lstat(to);
            if (current.dev !== created.dev || current.ino !== created.ino)
              refuse(`Destination directory replaced: ${to}`);
          } finally {
            await targetHandle.close();
          }
        } finally {
          await sourceHandle.close();
        }
      }
    } else if (before.isFile()) {
      if (windows) windowsFilesystem(host).copy(from, to);
      else {
        const handle = await open(
          from,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const opened = await handle.stat();
          if (
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            !opened.isFile()
          )
            refuse(`Source replaced during copy: ${from}`);
          // /proc binds the copy to the no-follow fd, not a second pathname open.
          await copyFile(
            `/proc/self/fd/${handle.fd}`,
            to,
            constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
          );
          const created = await lstat(to);
          const target = await open(
            to,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const openedTarget = await target.stat();
            if (
              openedTarget.dev !== created.dev ||
              openedTarget.ino !== created.ino ||
              !openedTarget.isFile() ||
              openedTarget.nlink !== 1
            )
              refuse(`Destination file replaced: ${to}`);
            await restoreMigrationGroup(to, before.gid, () =>
              target.chown(-1, before.gid),
            );
            await target.chmod(before.mode & 0o7777);
            await target.utimes(
              before.atimeMs / 1000,
              manifestTimestamp(before.mtimeMs),
            );
          } finally {
            await target.close();
          }
        } finally {
          await handle.close();
        }
      }
    } else if (!windows && before.isSymbolicLink()) {
      await symlink(await readlink(from), to);
      // to is anchored to the open parent directory; lchown never follows the leaf.
      await restoreMigrationGroup(to, before.gid, () =>
        lchown(to, -1, before.gid),
      );
      await lutimes(
        to,
        before.atimeMs / 1000,
        manifestTimestamp(before.mtimeMs),
      );
    } else if (!(before.isSocket() && relative.startsWith('runtime/')))
      refuse(`Unsupported source entry: ${from}`);
    const after = await lstat(from);
    if (
      before.dev !== after.dev ||
      (windows
        ? beforeIdentity !== (await migrationNodeIdentity(from, after))
        : before.ino !== after.ino) ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      refuse(`Source changed during construction: ${from}`);
    const copied = before.isSocket() ? null : await lstat(to);
    if (
      copied &&
      ((before.isFile() && copied.nlink !== 1) ||
        copied.dev !== before.dev ||
        (windows
          ? (await migrationNodeIdentity(to, copied)) === beforeIdentity
          : copied.ino === before.ino) ||
        (!windows && (copied.uid !== before.uid || copied.gid !== before.gid)))
    )
      refuse(`Copied entry identity or ownership differs: ${to}`);
    entries += 1;
    internalRootMigrationProgress(`${entries} copied entries`);
  }
  await visit(source, destination);
}

function manifestTimestamp(milliseconds: number): number {
  // The manifest records milliseconds; stay inside that bucket after utimes rounding.
  return Math.floor(milliseconds) / 1000 + 0.000001;
}
