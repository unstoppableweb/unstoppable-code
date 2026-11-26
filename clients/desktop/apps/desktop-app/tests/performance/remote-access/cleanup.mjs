/**
 * Everything a Remote Control run starts registers here (desktops, relays,
 * proxies, the mock server), so a run that fails or is interrupted still
 * closes them. `run.mjs` runs the cleanup on success, on error and on
 * SIGINT/SIGTERM, then exits, which ends the guarded command and releases
 * the shared performance lock. A run killed outright is covered by the
 * process-tree supervisor every launched app and relay already runs under.
 */
const tasks = new Set();
const removals = new Set();

/** Registers `close`; the returned function unregisters it. */
export function onCleanup(close) {
  const task = { close };
  tasks.add(task);
  return () => tasks.delete(task);
}

/**
 * Registers a synchronous removal, such as a temporary directory. A signal
 * runs these before anything can yield to Playwright's own SIGINT handler,
 * which exits the process once the apps are closed.
 */
export function onCleanupSync(remove) {
  const task = { remove };
  removals.add(task);
  return () => removals.delete(task);
}

/** Runs every registered removal, newest first; never throws. */
export function runCleanupSync() {
  const pending = [...removals].reverse();
  removals.clear();
  for (const task of pending) {
    try {
      task.remove();
    } catch {
      // Keep removing the rest.
    }
  }
}

/**
 * Closes everything still registered, newest first, then runs the
 * removals; never throws.
 */
export async function runCleanup() {
  const pending = [...tasks].reverse();
  tasks.clear();
  for (const task of pending) {
    try {
      await task.close();
    } catch {
      // Keep closing the rest; a failed close must not leak the others.
    }
  }
  runCleanupSync();
}
