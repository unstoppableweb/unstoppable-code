import log from 'electron-log/main.js';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const JEST_FILE_LOGGING_ENV = 'CANOPY_JEST_FILE_LOGGING';
const JEST_LOG_DIR_ENV = 'CANOPY_JEST_LOG_DIR';

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Prevent unit tests from writing through electron-log's default macOS file
 * transport into ~/Library/Logs/Canopy/main.log.
 *
 * File logging remains available for test debugging by setting
 * CANOPY_JEST_FILE_LOGGING=1. Opted-in logs are isolated by worktree and Jest
 * worker under the OS temp directory, or beneath CANOPY_JEST_LOG_DIR when an
 * explicit base directory is supplied.
 */
export function configureJestElectronLog(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  workerId: string = env.JEST_WORKER_ID ?? String(process.pid),
): string | null {
  if (env[JEST_FILE_LOGGING_ENV] !== '1') {
    log.transports.file.level = false;
    return null;
  }

  const worktreeHash = createHash('sha256')
    .update(resolve(cwd))
    .digest('hex')
    .slice(0, 12);
  const requestedBaseDirectory = env[JEST_LOG_DIR_ENV]?.trim();
  const baseDirectory = requestedBaseDirectory
    ? resolve(cwd, requestedBaseDirectory)
    : join(
        tmpdir(),
        'canopy-jest-logs',
        `${safePathSegment(basename(cwd))}-${worktreeHash}`,
      );
  const logPath = join(
    baseDirectory,
    `worker-${safePathSegment(workerId)}`,
    'main.log',
  );

  log.transports.file.resolvePathFn = (): string => logPath;
  log.transports.file.level = 'silly';
  return logPath;
}

configureJestElectronLog();

// jsdom implements no layout, so it ships no `Element.prototype.scrollIntoView`.
// Any suite rendering the real shared `ChatTranscript` hits it, because the
// transcript autoscrolls to its bottom sentinel on mount. Stub it here rather
// than making product code defensive about a jsdom gap. Guarded so the
// node-environment suites (which have no `Element`) are unaffected.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
