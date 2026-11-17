import { constants, type Stats } from 'node:fs';
import { lstat, link, open, unlink, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createDirectoryDurably, syncDirectory } from '../lib/atomic-file';

export type CopilotClaimStep = 'claim' | 'detach' | 'remove';
function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
function identical(a: Stats, b: Stats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
}
/** Only callable inside the actual credential queue. This is logical cleanup, not secure erasure. */
export async function copilotCleanupClaim(options: {
  sourcePath: string;
  dataRoot: string;
  operationId: string;
  generation: string;
  step: CopilotClaimStep;
}): Promise<'done' | 'changed' | 'unavailable'> {
  if (
    !/^[a-f0-9-]{36}$/.test(options.operationId) ||
    !/^[a-f0-9]{64}$/.test(options.generation)
  )
    return 'unavailable';
  const directory = join(options.dataRoot, 'copilot-qualification', 'claims');
  const claim = join(directory, `${options.operationId}.enc`);
  async function stat(path: string): Promise<Stats | null> {
    try {
      return await lstat(path);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async function verifyClaim(expectedLinks: number): Promise<void> {
    const before = await lstat(claim);
    if (
      !before.isFile() ||
      before.nlink !== expectedLinks ||
      before.size < 1 ||
      before.size > 1048576
    )
      throw new Error('Claim layout unavailable.');
    const file = await open(claim, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!identical(before, opened))
        throw new Error('Claim identity changed.');
      const bytes = await file.readFile();
      try {
        if (
          createHash('sha256').update(bytes).digest('hex') !==
          options.generation
        )
          throw new Error('Claim generation changed.');
      } finally {
        bytes.fill(0);
      }
      const after = await file.stat();
      const named = await lstat(claim);
      if (
        !identical(before, named) ||
        after.nlink !== expectedLinks ||
        named.nlink !== expectedLinks ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error('Claim changed.');
      await file.sync();
    } finally {
      await file.close();
    }
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(directory));
    const dir = await lstat(directory);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      !dir.isDirectory() ||
      dir.isSymbolicLink()
    )
      return 'unavailable';
    await chmod(directory, 0o700);
    await createDirectoryDurably(directory, { dataRoot: options.dataRoot });
    if (options.step === 'remove') {
      // Core's durable remove_authorized is required even when unlink's acknowledgement was lost.
      const claimed = await stat(claim);
      if (claimed) {
        await verifyClaim(1);
        const current = await stat(options.sourcePath);
        if (current && identical(claimed, current)) return 'changed';
        const rechecked = await lstat(claim);
        if (
          !identical(claimed, rechecked) ||
          rechecked.nlink !== 1 ||
          rechecked.size !== claimed.size ||
          rechecked.mtimeMs !== claimed.mtimeMs ||
          rechecked.ctimeMs !== claimed.ctimeMs
        )
          return 'changed';
        await unlink(claim);
      }
      await syncDirectory(directory);
      return 'done';
    }
    let source = await stat(options.sourcePath);
    let claimed = await stat(claim);
    if (options.step === 'claim' && !claimed) {
      if (!source?.isFile() || source.nlink !== 1) return 'changed';
      try {
        await link(options.sourcePath, claim);
      } catch (error) {
        if (
          !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'EEXIST'
          )
        )
          return 'unavailable'; // unsupported hard links preserve the source, with no rename fallback
      }
      claimed = await stat(claim);
      source = await stat(options.sourcePath);
    }
    if (!claimed) return 'unavailable'; // absence never establishes detach
    if (source) {
      if (
        !identical(source, claimed) ||
        source.nlink !== 2 ||
        claimed.nlink !== 2
      )
        return 'changed';
      await verifyClaim(2); // the one operation-owned additional link is allowed
      const rechecked = await lstat(options.sourcePath);
      if (!identical(rechecked, claimed) || rechecked.nlink !== 2)
        return 'changed';
    } else {
      if (options.step !== 'detach') return 'changed';
      // Only durable claim_ready permits this recovery path.
      await verifyClaim(1);
    }
    await syncDirectory(directory);
    if (options.step === 'claim') return 'done';
    if (source) {
      // Directory durability can yield to a replacement. Recheck after that await,
      // not only before it; the queue excludes the sanctioned source writers.
      const namedClaim = await lstat(claim);
      const rechecked = await lstat(options.sourcePath);
      if (
        !identical(claimed, namedClaim) ||
        !identical(rechecked, namedClaim) ||
        rechecked.nlink !== 2 ||
        namedClaim.nlink !== 2 ||
        namedClaim.size !== claimed.size ||
        namedClaim.mtimeMs !== claimed.mtimeMs ||
        namedClaim.ctimeMs !== claimed.ctimeMs
      )
        return 'changed';
      await unlink(options.sourcePath);
    }
    await syncDirectory(dirname(options.sourcePath));
    return 'done';
  } catch {
    return 'unavailable';
  }
}
