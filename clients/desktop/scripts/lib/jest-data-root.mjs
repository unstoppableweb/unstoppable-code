import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CAN-6669: every root Jest worker gets a private data root
// (apps/desktop-app/src/__tests__/jestDataDirIsolation.ts). Jest's globalSetup
// makes one directory for the run, and each worker's root goes inside it, so
// globalTeardown removes every worker's root at once, whether tests passed or
// failed. Before, each worker left a `canopy-jest-<hash>` directory behind:
// about 2,400 a night on a shared Mac.

/** The run directory every worker's data root goes in. */
export const JEST_RUN_DATA_ROOT_ENV = 'CANOPY_JEST_RUN_DATA_ROOT';

/**
 * The longest Unix socket path the core daemon can bind (macOS's limit;
 * Linux allows 107). See `address` in `@canopy/core-platform/endpoints`.
 */
const SOCKET_PATH_LIMIT_BYTES = 103;

/** The longest path under a run directory: a worker's daemon socket. */
const LONGEST_WORKER_SOCKET = join(
  'w99999-9999999',
  'data',
  'runtime',
  '.000000000000',
);

function canonical(directory) {
  try {
    return realpathSync.native(directory);
  } catch {
    return directory;
  }
}

/**
 * Creates the run directory and exports it to the workers. It goes under the
 * temporary directory, or under `/tmp` when a worker's daemon socket there
 * would be too long, as it can be under agents' scratch directories.
 */
export function createJestRunDataRoot(
  env = process.env,
  temporaryDirectory = tmpdir(),
  platform = process.platform,
) {
  const preferred = canonical(temporaryDirectory);
  const fits =
    platform === 'win32' ||
    Buffer.byteLength(
      join(preferred, 'canopy-jest-XXXXXX', LONGEST_WORKER_SOCKET),
    ) <= SOCKET_PATH_LIMIT_BYTES;
  const root = mkdtempSync(
    join(fits ? preferred : canonical('/tmp'), 'canopy-jest-'),
  );
  env[JEST_RUN_DATA_ROOT_ENV] = root;
  return root;
}

function makeWritable(directory) {
  try {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory()) makeWritable(join(directory, entry.name));
  } catch {
    // Removal below reports what is still in the way.
  }
}

/**
 * Removes the run directory and every worker root in it. A test that left a
 * directory read-only doesn't keep it: a failed removal makes the tree
 * writable and tries again.
 */
export function removeJestRunDataRoot(root, env = process.env) {
  if (env[JEST_RUN_DATA_ROOT_ENV] === root) delete env[JEST_RUN_DATA_ROOT_ENV];
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
