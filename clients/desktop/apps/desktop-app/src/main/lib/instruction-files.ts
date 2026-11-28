import { constants, type Stats } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  createRelativeAliasExclusive,
  ensureRelativeAlias,
  ensureRelativeSymlink as ensureRelativeSymlinkWithPort,
  hasExpectedRelativeAlias,
  type InstructionAliasPort,
} from '@canopy/core-runtime/node/workspace/instruction-files';

export {
  isProjectInstructionFileReadable,
  resolveOptionalProjectInstructionFile,
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
  writeProjectInstructionFile,
  type ProjectInstructionFile,
} from '@canopy/desktop-shared/node/lib/project-instruction-files';

// This module stays the writer of desktop AGENTS.md aliases; the alias policy
// lives in core-runtime (CAN-4106).
const aliasPort: InstructionAliasPort = {
  lstat: (path) => lstat(path),
  readlink: (path) => readlink(path),
  readText: (path) => readFile(path, 'utf8'),
  remove: (path) => rm(path, { recursive: true, force: true }),
  symlink: (target, path) => symlink(target, path),
  hardLink: (existingPath, path) => link(existingPath, path),
  copyFile: (source, destination) => copyFile(source, destination),
};

export function ensureRelativeSymlink(
  linkPath: string,
  targetPath: string,
): Promise<void> {
  return ensureRelativeSymlinkWithPort(linkPath, targetPath, aliasPort);
}

export function ensureRelativeSymlinkOrCopy(
  linkPath: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return ensureRelativeAlias(
    linkPath,
    targetPath,
    { platform, posixPermissionFallback: true },
    aliasPort,
  );
}

export function hasExpectedRelativeSymlinkOrCopy(
  linkPath: string,
  targetPath: string,
): Promise<boolean> {
  return hasExpectedRelativeAlias(linkPath, targetPath, aliasPort);
}

/** Windows hard links or copies; POSIX symlinks with no permission fallback. */
export function ensureAgentsMdSymlink(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return ensureRelativeAlias(
    join(dir, 'AGENTS.md'),
    'CLAUDE.md',
    { platform, posixPermissionFallback: false },
    aliasPort,
  );
}

/** As {@link ensureAgentsMdSymlink}, but POSIX falls back after EPERM/EACCES. */
export function ensureAgentsMdSymlinkOrCopy(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return ensureRelativeSymlinkOrCopy(
    join(dir, 'AGENTS.md'),
    'CLAUDE.md',
    platform,
  );
}

export function hasExpectedAgentsMdSymlinkOrCopy(
  dir: string,
): Promise<boolean> {
  return hasExpectedRelativeSymlinkOrCopy(join(dir, 'AGENTS.md'), 'CLAUDE.md');
}

async function copyObservedFileExclusive(
  source: string,
  destination: string,
  snapshot: { bytes: Buffer; stats: Stats },
): Promise<void> {
  // Keep the native-copy source in an account temp directory outside the
  // managed folder, whose entries can be edited independently.
  const staging = await mkdtemp(join(tmpdir(), 'canopy-instructions-'));
  const assertSource = (current: Stats): void => {
    const expected = snapshot.stats;
    if (
      !current.isFile() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.size !== expected.size ||
      current.ctimeMs !== expected.ctimeMs ||
      current.mtimeMs !== expected.mtimeMs
    )
      throw new Error('The instruction source changed while pairing.');
  };
  try {
    const staged = join(staging, 'copy-source');
    assertSource(await lstat(source));
    // The Windows native copy retains file encryption or fails. Stage it
    // first so a source change or an incomplete copy cannot be published.
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    const file = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.readFile()).equals(snapshot.bytes))
        throw new Error('The instruction source changed while pairing.');
    } finally {
      await file.close();
    }
    const live = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assertSource(await live.stat());
      if (!(await live.readFile()).equals(snapshot.bytes))
        throw new Error('The instruction source changed while pairing.');
      assertSource(await lstat(source));
      await copyFile(staged, destination, constants.COPYFILE_EXCL);
    } finally {
      await live.close();
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export type InstructionCounterpartCreation =
  | { method: 'copy' }
  | { method: 'symlink' | 'hard-link'; stats: Stats };

/** Additive pairing for user-owned folders; occupied entries always fail. */
export async function createInstructionCounterpartExclusive(
  dir: string,
  primary: 'AGENTS.md' | 'CLAUDE.md',
  platform: NodeJS.Platform = hostOperatingSystem() ?? 'linux',
  options?: {
    allowWindowsCompatibilityFallback?: boolean;
    sourceSnapshot?: { bytes: Buffer; stats: Stats };
  },
): Promise<InstructionCounterpartCreation | undefined> {
  const sourceSnapshot = options?.sourceSnapshot;
  const counterpart = join(
    dir,
    primary === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md',
  );
  const method = await createRelativeAliasExclusive(
    counterpart,
    primary,
    platform,
    {
      symlink: (target, path) => aliasPort.symlink(target, path),
      hardLink: (source, path) => aliasPort.hardLink(source, path),
      copyFileExclusive: (source, destination) =>
        sourceSnapshot
          ? copyObservedFileExclusive(source, destination, sourceSnapshot)
          : copyFile(source, destination, constants.COPYFILE_EXCL),
    },
    options,
  );
  if (!sourceSnapshot) return undefined;
  // Native copy gives no destination handle. The caller can observe the new
  // pair for reading, but must not treat a pathname lookup as proof of ownership.
  if (method === 'copy') return { method };
  const entry = await lstat(counterpart);
  const matchesCreated =
    method === 'symlink'
      ? entry.isSymbolicLink() && (await readlink(counterpart)) === primary
      : entry.isFile() &&
        entry.dev === sourceSnapshot.stats.dev &&
        entry.ino === sourceSnapshot.stats.ino;
  if (!matchesCreated)
    throw new Error('The instruction counterpart changed while pairing.');
  return { method, stats: entry };
}
