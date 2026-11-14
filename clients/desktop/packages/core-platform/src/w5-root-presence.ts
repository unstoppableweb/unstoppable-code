import { readW5RootEvidence } from '@canopy/core-runtime/node/w5/service-history';
import { randomUUID } from 'node:crypto';
import type { PlatformProcessInspection } from '@canopy/core-runtime';
import { lstat, realpath, readdir, unlink, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { hostOperatingSystem } from './host-platform';
import { ensureW5PrivateRuntimeDirectory } from './w5-process-file-lock';
import { flushDirectory } from './directory-flush';
import { hostPlatformOperatingSystem } from './platform-services';
import { createSupervisionServices } from './supervision';

export interface W5RootPresence {
  isHeld(): boolean;
  close(): void;
}

export class W5RootPresenceBusyError extends Error {
  constructor(
    readonly busyCause: unknown,
    readonly errcode: 5 | 6,
  ) {
    super('W5 root presence admission is busy.');
    this.name = 'W5RootPresenceBusyError';
  }
}

async function inspectSelf(): Promise<PlatformProcessInspection> {
  return createSupervisionServices(
    hostPlatformOperatingSystem(),
  ).inspectProcess({
    pid: process.pid,
  });
}

async function beginPresence(
  db: DatabaseSync,
  kind: 'host' | 'maintenance',
): Promise<boolean> {
  const deadline = performance.now() + 2_000;
  let needsDirectoryFlush = false;
  for (;;) {
    try {
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete')
        throw new Error('Unsafe W5 root presence journal.');
      if (db.prepare('PRAGMA user_version').get()?.user_version === 0) {
        needsDirectoryFlush = true;
        db.exec('BEGIN EXCLUSIVE');
        if (
          db.prepare('PRAGMA user_version').get()?.user_version === 0 &&
          !db.prepare('SELECT name FROM sqlite_master LIMIT 1').get()
        )
          db.exec(
            'CREATE TABLE presence (id INTEGER PRIMARY KEY CHECK (id = 1)) STRICT; INSERT INTO presence VALUES (1); PRAGMA user_version = 1; COMMIT',
          );
        else db.exec('ROLLBACK');
      }
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
        throw new Error('Unsupported W5 root presence version.');
      db.exec(kind === 'maintenance' ? 'BEGIN EXCLUSIVE' : 'BEGIN');
      if (db.prepare('SELECT id FROM presence').get()?.id !== 1)
        throw new Error('Invalid W5 root presence record.');
      return needsDirectoryFlush;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      const errcode: unknown =
        typeof error === 'object' && error !== null
          ? Reflect.get(error, 'errcode')
          : undefined;
      const remaining = deadline - performance.now();
      if (kind !== 'host' || (errcode !== 5 && errcode !== 6)) throw error;
      if (remaining <= 0) throw new W5RootPresenceBusyError(error, errcode);
      // Recheck the version: another initializer may now hold lifetime SHARED.
      await delay(Math.min(25, remaining));
    }
  }
}

/**
 * Permanent root exclusion, independent of leases and the legacy host cohort.
 * Hosts hold SHARED through drain/idle grace; cold maintenance holds EXCLUSIVE.
 * Never rename/remove this inode. SQLite releases presence on process death.
 * Maintenance contention immediately preserves SQLite's BUSY/LOCKED error;
 * only exhausted host admission wraps it in W5RootPresenceBusyError.
 */
export async function acquireW5RootPresence(
  dataRoot: string,
  kind: 'host' | 'maintenance',
  hostKind = 'host',
  inspect: () => Promise<PlatformProcessInspection> = inspectSelf,
): Promise<W5RootPresence> {
  const root = await realpath(resolve(dataRoot));
  // This inode outlives daemon publication and transient runtime cleanup.
  const directory = join(root, 'w5-presence');
  await ensureW5PrivateRuntimeDirectory(directory);
  const path = join(directory, 'w5-root-presence.sqlite');
  // SQLite creates with umask permissions; peers must only ever see private mode.
  // Exclusive creation never opens/closes an existing SQLite lock inode.
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      Reflect.get(error, 'code') !== 'EEXIST'
    )
      throw error;
  }
  const stat = await lstat(path);
  const posix = hostOperatingSystem() !== 'win32';
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (posix && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
  )
    throw new Error('Unsafe W5 root presence file.');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    if (await beginPresence(db, kind)) await flushDirectory(directory);
    const identity = await lstat(path);
    // Retrying must not bind an old connection's lock to a replacement inode.
    if (identity.dev !== stat.dev || identity.ino !== stat.ino)
      throw new Error('W5 root presence file replaced during admission.');
    let peerPath: string | undefined;
    if (kind === 'host') {
      const peers = join(directory, 'peers');
      await ensureW5PrivateRuntimeDirectory(peers);
      const self = await inspect();
      const startIdentity =
        self.state === 'running' ? self.startIdentity : null;
      peerPath = join(peers, `${randomUUID()}.json`);
      await writeFile(
        peerPath,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          startIdentity,
          hostKind,
        }),
        { flag: 'wx', mode: 0o600 },
      );
    }
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      process.off('exit', close);
      // Peer labels are advisory only; failed cleanup never releases exclusion early.
      try {
        if (peerPath) unlinkSync(peerPath);
      } catch {
        /* filtered by liveness after exit */
      }
      db.close();
    };
    if (kind === 'host') process.once('exit', close);
    return {
      close,
      isHeld: (): boolean => {
        if (closed || !db.isTransaction) return false;
        try {
          const current = lstatSync(path);
          return (
            realpathSync(root) === root &&
            realpathSync(directory) === directory &&
            current.isFile() &&
            current.nlink === 1 &&
            current.dev === identity.dev &&
            current.ino === identity.ino
          );
        } catch {
          return false;
        }
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Advisory labels only: maintenance safety comes from the exclusive lock. */
export async function listW5RootPresencePeers(options: {
  dataRoot: string;
  inspect: (pid: number) => Promise<PlatformProcessInspection>;
}): Promise<readonly string[]> {
  let directory: string;
  let names: string[];
  try {
    const root = await realpath(resolve(options.dataRoot));
    directory = join(root, 'w5-presence', 'peers');
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      (await realpath(directory)) !== directory ||
      (hostOperatingSystem() !== 'win32' &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      return ['unknown'];
    names = await readdir(directory);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'ENOENT'
    )
      return [];
    return ['unknown'];
  }
  const peers: string[] = [];
  for (const name of names) {
    try {
      const path = join(directory, name);
      const value = await readW5RootEvidence(path);
      if (value === undefined) continue;
      if (typeof value !== 'object' || value === null) {
        peers.push('unknown');
        continue;
      }
      const pid: unknown = Reflect.get(value, 'pid');
      const kind: unknown = Reflect.get(value, 'hostKind');
      if (
        Reflect.get(value, 'version') !== 1 ||
        typeof pid !== 'number' ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        typeof kind !== 'string' ||
        !kind.length ||
        kind.length > 64
      ) {
        peers.push('unknown');
        continue;
      }
      const observed = await options.inspect(pid);
      const startIdentity: unknown = Reflect.get(value, 'startIdentity');
      const identified =
        typeof startIdentity === 'string' && startIdentity.length > 0;
      if (
        observed.state === 'absent' ||
        (observed.state === 'running' &&
          identified &&
          observed.startIdentity.length > 0 &&
          observed.startIdentity !== startIdentity)
      ) {
        await unlink(path);
        continue;
      }
      if (
        observed.state !== 'running' ||
        !identified ||
        !observed.startIdentity.length
      )
        peers.push('unknown');
      else if (pid !== process.pid) peers.push(kind);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        Reflect.get(error, 'code') !== 'ENOENT'
      )
        peers.push('unknown');
    }
  }
  return peers;
}
