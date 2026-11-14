import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The longest Unix socket path the core daemon can bind (macOS's limit;
 * Linux allows 107). See `address` in `@canopy/core-platform/endpoints`.
 */
const SOCKET_PATH_LIMIT_BYTES = 103;

/** Whether the daemon socket of `<root>/data` fits, with its bind sibling. */
function socketFits(root: string): boolean {
  return (
    Buffer.byteLength(join(root, 'data', 'runtime', '.000000000000')) <=
    SOCKET_PATH_LIMIT_BYTES
  );
}

function canonical(directory: string): string {
  try {
    return realpathSync.native(directory);
  } catch {
    return directory;
  }
}

/**
 * Keep unit tests out of the developer's real data directory.
 *
 * Jest runs with `NODE_ENV=test`, which the runtime-mode resolver maps to the
 * production brand root (`~/.canopy`). Any test that reaches an unmocked
 * writer — observability diagnostics, caches, registries — therefore wrote
 * into the live desktop app's data (fixture sessions such as
 * `workspace-1/worktree-1` appeared in real session diagnostics). Every Jest
 * worker now defaults to a private temporary root; a test that sets or deletes
 * these variables itself still controls resolution.
 *
 * The root is one short hashed name, because the core daemon's socket lives
 * in the data root (CAN-5685). Under a temporary directory too long for that
 * socket, as agents' scratch directories can be, it goes under `/tmp`.
 *
 * In a run Jest's globalSetup prepared, the root goes inside the run's
 * directory (`CANOPY_JEST_RUN_DATA_ROOT`) instead, which globalTeardown
 * removes with every worker's root (CAN-6669). The run directory already has
 * room for the socket.
 */
export function configureJestDataDirIsolation(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  workerId: string = env.JEST_WORKER_ID ?? String(process.pid),
  temporaryDirectory: string = tmpdir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const runRoot = env.CANOPY_JEST_RUN_DATA_ROOT?.trim();
  const root = runRoot
    ? join(runRoot, `w${workerId}-${process.pid}`)
    : standaloneRoot(cwd, workerId, temporaryDirectory, platform);
  if (!env.CANOPY_DATA_DIR?.trim()) {
    env.CANOPY_DATA_DIR = join(root, 'data');
  }
  if (!env.CANOPY_SECURE_DATA_DIR?.trim()) {
    env.CANOPY_SECURE_DATA_DIR = join(root, 'secure');
  }
  return root;
}

/** A worker's root when no globalSetup prepared a run directory. */
function standaloneRoot(
  cwd: string,
  workerId: string,
  temporaryDirectory: string,
  platform: NodeJS.Platform,
): string {
  const name = `canopy-jest-${createHash('sha256')
    .update(`${cwd}\0${process.pid}\0${workerId}`)
    .digest('hex')
    .slice(0, 16)}`;
  const preferred = join(canonical(temporaryDirectory), name);
  return platform === 'win32' || socketFits(preferred)
    ? preferred
    : join(canonical('/tmp'), name);
}

configureJestDataDirIsolation();
