import { open, readFile, rm } from 'node:fs/promises';
import { constants, mkdirSync } from 'node:fs';

import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import type { StorageOwnershipRow } from '../../../storage/writer-authority';
import type { PipelineDefinitionsWriterLock } from '../store/definitions-backup';

export const FAMILY = [
  'pipeline_definition_replays',
  'pipeline_data',
  'pipeline_definitions',
];

/** The ownership rows once the family's rows require a backup before their flip. */
export const FLIP_READY: readonly StorageOwnershipRow[] = [
  ...STORAGE_OWNERSHIP.filter((row) => !FAMILY.includes(row.id)),
  ...FAMILY.map(
    (id): StorageOwnershipRow => ({
      id,
      transitionOwner: 'legacy',
      currentWriters: ['electron_main'],
      schemaVersion: id === 'pipeline_definitions' ? 'none' : 1,
      backupPolicy: 'required_before_flip',
      backupShape: 'namespace_backup',
      workPackage: 'W6',
    }),
  ),
];

/**
 * The real POSIX folder flush: core-platform's secure-files port opens the
 * path with `O_RDONLY | O_DIRECTORY` and fsyncs it, so a missing path rejects
 * with ENOENT and a non-folder with ENOTDIR.
 */
export async function strictFlush(path: string): Promise<'flushed'> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return 'flushed';
}

export interface RecordingLock extends PipelineDefinitionsWriterLock {
  /** Whether the lock is held right now. */
  readonly held: () => boolean;
  /** Every lock file taken, in order. */
  readonly paths: string[];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * An exclusive lock file holding its owner's pid, created with `wx` and
 * removed on release. Like core-platform's lock, it reclaims a file whose
 * owner has exited and fails at once when a live owner holds it, as a held
 * lock does once its wait ends.
 */
export function recordingLock(): RecordingLock {
  let depth = 0;
  const paths: string[] = [];
  return {
    held: () => depth > 0,
    paths,
    ensurePrivateLockDirectory: (directory) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return Promise.resolve();
    },
    withOwnerLockFile: async (lockPath, operation, options) => {
      paths.push(lockPath);
      let handle = await open(lockPath, 'wx').catch(() => undefined);
      if (handle === undefined) {
        const owner = Number(await readFile(lockPath, 'utf8').catch(() => ''));
        if (!Number.isInteger(owner) || owner <= 0 || isAlive(owner))
          throw new Error(options.timeoutMessage);
        await rm(lockPath, { force: true });
        handle = await open(lockPath, 'wx');
      }
      await handle.writeFile(String(process.pid));
      await handle.close();
      depth += 1;
      try {
        return await operation();
      } finally {
        depth -= 1;
        await rm(lockPath, { force: true });
      }
    },
  };
}
