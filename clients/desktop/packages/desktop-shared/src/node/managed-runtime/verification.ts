import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileReadResult } from 'node:fs/promises';
import { access, lstat, open } from 'node:fs/promises';

const MAX_EXECUTABLE_BYTES = 600 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * The fields that tie a verdict to one file: replacing the file changes its
 * inode, and writing to it changes its size, mtime or ctime. Renaming a
 * parent directory changes none of them, so the bytes are read through one
 * handle whose identity is compared, never reopened by path.
 */
export interface ManagedExecutableIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function sameFile(
  a: ManagedExecutableIdentity,
  b: ManagedExecutableIdentity,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/**
 * Bounded streaming verification of the exact native binary pinned in the
 * manifest. The file is opened once, without following a symlink, and the
 * hash is read through that handle. The handle must be the file the path
 * named before the read (and `expected`, when the caller took the identity
 * earlier), must not change while it is read, and the path must still name
 * it afterwards. A directory swap during the read therefore refuses instead
 * of hashing one file and approving another.
 */
export async function verifyManagedExecutable(
  file: string,
  expectedSha256: string,
  signal: AbortSignal,
  label: string,
  expected?: ManagedExecutableIdentity,
): Promise<void> {
  signal.throwIfAborted();
  const failed = (): Error =>
    new Error(
      `${label} runtime verification failed. Reconnect ${label} in Settings.`,
    );
  const info = await lstat(file, { bigint: true });
  if (
    !info.isFile() ||
    info.size > MAX_EXECUTABLE_BYTES ||
    !/^[a-f0-9]{64}$/.test(expectedSha256)
  )
    throw failed();
  if (process.platform !== 'win32') await access(file, constants.X_OK);
  // Windows has no O_NOFOLLOW or O_NONBLOCK (the constants are undefined, so
  // they add no bit); the lstat above already refused a link there.
  // O_NONBLOCK: a FIFO swapped in after the lstat would otherwise block the
  // open until a writer appears, before the handle's type check can refuse
  // it. It changes nothing for reads of a regular file.
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let reading: Promise<FileReadResult<Buffer>> | undefined;
  try {
    const opened: BigIntStats = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !sameFile(opened, info) ||
      (expected !== undefined && !sameFile(opened, expected))
    )
      throw failed();
    const hash = createHash('sha256');
    // Two buffers, so the next read runs while the current chunk is hashed.
    // Strictly alternating read and hash was about 10% slower than the
    // stream this replaced (platform-performance.md, Verifier timing).
    const buffers = [
      Buffer.allocUnsafe(READ_CHUNK_BYTES),
      Buffer.allocUnsafe(READ_CHUNK_BYTES),
    ];
    let current = 0;
    let bytes = 0;
    reading = handle.read(buffers[current], 0, READ_CHUNK_BYTES, 0);
    for (;;) {
      const { bytesRead } = await reading;
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_EXECUTABLE_BYTES)
        throw new Error(`${label} runtime exceeds its size limit.`);
      const chunk = buffers[current].subarray(0, bytesRead);
      current = 1 - current;
      reading = handle.read(buffers[current], 0, READ_CHUNK_BYTES, bytes);
      hash.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    if (
      BigInt(bytes) !== opened.size ||
      !sameFile(after, opened) ||
      !named.isFile() ||
      !sameFile(named, opened) ||
      hash.digest('hex') !== expectedSha256
    )
      throw failed();
  } finally {
    // A refusal or cancellation can leave the read-ahead in flight; settle it
    // before the handle closes.
    await reading?.catch(() => undefined);
    await handle.close();
  }
  // A check cancelled during its final reads is not a pass: callers such as
  // the installer act on success, for example by pruning older runtimes.
  signal.throwIfAborted();
}
