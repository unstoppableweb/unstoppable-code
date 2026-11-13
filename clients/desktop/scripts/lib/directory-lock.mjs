/**
 * A cross-process lock for dev scripts that never deletes a lock to take it
 * over, so a waiter acting on an outdated view can't remove a lock another
 * process has just taken.
 *
 * `lockPath` is a directory of numbered generations. Generation `n` is held
 * by the process that created `<lockPath>/<n>` with `mkdir`, which exactly one
 * process can do. Its `holder.json` names the holder's pid and a token. To
 * release, the holder writes a `released` marker into its own generation.
 * To take the lock, a process creates the generation after the newest one,
 * which it may do only when the newest is released, its holder is gone (after
 * `graceMs`, which covers a holder that died between `mkdir` and writing
 * `holder.json`), or, with `staleMs`, it is older than that even though a
 * process with the holder's pid is alive (a hung holder, or a reused pid).
 * Two processes that both judge the newest generation free race on the same
 * `mkdir`, and one loses and looks again.
 *
 * The new holder deletes older generations. A process whose view predates
 * that cleanup could recreate one of them, so after creating a generation,
 * a process checks that none newer exists, and gives it up if one does.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const RELEASED = 'released';

function sleep(ms) {
  Atomics.wait(sleepArray, 0, 0, ms);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function generations(lockPath) {
  return readdirSync(lockPath)
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

function readHolder(generationPath) {
  try {
    return JSON.parse(
      readFileSync(join(generationPath, 'holder.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}

/** Whether generation `n` may be succeeded, and its holder when it may not. */
function judge(lockPath, n, { graceMs, staleMs }) {
  const generationPath = join(lockPath, String(n));
  if (existsSync(join(generationPath, RELEASED))) return { free: true };
  const holder = readHolder(generationPath);
  let startedAtMs = Date.parse(holder?.startedAt ?? '');
  if (Number.isNaN(startedAtMs)) {
    try {
      startedAtMs = statSync(generationPath).mtimeMs;
    } catch {
      // Cleaned up since the listing; the caller looks again.
      return { free: false, holder: null, vanished: true };
    }
  }
  const ageMs = Date.now() - startedAtMs;
  const holderGone =
    ageMs >= graceMs && (!holder || !processIsAlive(holder.pid));
  const stale = staleMs !== undefined && ageMs >= staleMs;
  return { free: holderGone || stale, holder };
}

/**
 * Takes the lock at `lockPath`, waiting up to `timeoutMs`. `onWait` is called
 * once, with the holder (or null), the first time the lock is found held.
 * Throws `timeoutMessage` when the wait runs out.
 */
export function acquireDirectoryLock({
  lockPath,
  timeoutMs,
  graceMs,
  staleMs,
  retryMs = 100,
  timeoutMessage = `Timed out waiting for the lock at ${lockPath}`,
  onWait,
}) {
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let waited = false;
  while (Date.now() < deadline) {
    const existing = generations(lockPath);
    const newest = existing.at(-1);
    if (newest !== undefined) {
      const verdict = judge(lockPath, newest, { graceMs, staleMs });
      if (verdict.vanished) continue;
      if (!verdict.free) {
        if (!waited) {
          waited = true;
          onWait?.(verdict.holder);
        }
        sleep(retryMs);
        continue;
      }
    }
    const mine = (newest ?? 0) + 1;
    const generationPath = join(lockPath, String(mine));
    try {
      mkdirSync(generationPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    try {
      writeFileSync(
        join(generationPath, 'holder.json'),
        `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
    } catch (error) {
      // A recreated old generation that a newer holder cleaned up again
      // (ENOENT), or that another delayed process recreated and claimed
      // first (EEXIST). Either way it isn't ours; look again.
      if (error?.code === 'ENOENT' || error?.code === 'EEXIST') continue;
      throw error;
    }
    const release = () => {
      try {
        writeFileSync(join(generationPath, RELEASED), '', { flag: 'wx' });
      } catch {
        // Already released, or cleaned up after a newer holder took over.
      }
    };
    if (generations(lockPath).some((n) => n > mine)) {
      // This number was recreated after a newer holder cleaned it up.
      release();
      continue;
    }
    for (const n of generations(lockPath)) {
      if (n < mine)
        rmSync(join(lockPath, String(n)), { recursive: true, force: true });
    }
    process.once('exit', release);
    return {
      waited,
      release() {
        process.removeListener('exit', release);
        release();
      },
    };
  }
  throw new Error(timeoutMessage);
}
