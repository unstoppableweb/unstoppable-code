import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const frameworkPath =
  'Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework';

function getElectronPlatformPath(platform) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error(
        `Electron builds are not available on platform: ${platform}`,
      );
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// Read the managed tree, following valid symlinks to required regular files.
function missingPieces(distRoot, relativePath, platform, version) {
  const missing = [];
  if (!isFile(path.join(distRoot, relativePath))) missing.push(relativePath);
  let installedVersion;
  try {
    installedVersion = readFileSync(path.join(distRoot, 'version'), 'utf8')
      .trim()
      .replace(/^v/, '');
  } catch {
    // Missing, unreadable and non-file version markers all require repair.
  }
  if (installedVersion !== version)
    missing.push(`version (expected ${version})`);
  if (
    (platform === 'darwin' || platform === 'mas') &&
    !isFile(path.join(distRoot, frameworkPath))
  ) {
    missing.push(frameworkPath);
  }
  return missing;
}

function run(spawn, command, args, options) {
  const result = spawn(command, args, options);
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`terminated by signal: ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(`exit ${result.status ?? 'unknown'}`);
  }
  return result;
}

// Budget: 3 attempts of at most 5 minutes each, plus 15s and 30s waits
// between them (under 16 minutes in total). Only download failures are
// retried; install.js verifies the archive checksum before it extracts.
const ELECTRON_INSTALL_RETRY_DELAYS_MS = [15_000, 30_000];
const ELECTRON_INSTALL_ATTEMPT_TIMEOUT_MS = 5 * 60_000;

// install.js prints only the @electron/get error stack, without its cause.
// Retry HTTP statuses that GitHub's CDN returns transiently, and undici's
// "terminated", which means the response body dropped mid-download. Do not
// retry "fetch failed": TLS, DNS, proxy and refused connections print it
// identically, so it cannot be told apart from a permanent failure.
const TRANSIENT_DOWNLOAD_FAILURE =
  /\bHTTPError: Response code (?:408|429|500|502|503|504)\b|\bTypeError: terminated\b/;

function isTransientElectronDownloadFailure(stderr) {
  return TRANSIENT_DOWNLOAD_FAILURE.test(stderr) && !/checksum/i.test(stderr);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runElectronInstaller(
  runAttempt,
  resetDist,
  { retryDelaysMs, attemptTimeoutMs },
) {
  const attempts = retryDelaysMs.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    resetDist();
    // stderr is captured to classify the failure, then echoed unchanged.
    const result = runAttempt();
    if (result.stderr) process.stderr.write(result.stderr);
    // A stalled download is killed by our own timeout and retried; any
    // other spawn error or signal fails immediately.
    const timedOut = result.error?.code === 'ETIMEDOUT';

    if (result.error && !timedOut) {
      throw new Error(
        `Electron binary install failed to start: ${result.error.message}`,
        { cause: result.error },
      );
    }

    if (result.signal && !timedOut) {
      throw new Error(
        `Electron binary install terminated by signal: ${result.signal}`,
      );
    }

    if (result.status === 0) return result;

    const failure = timedOut
      ? `Electron binary install timed out after ${attemptTimeoutMs}ms on attempt ${attempt}/${attempts}`
      : `Electron binary install failed (exit ${result.status ?? 'unknown'}) on attempt ${attempt}/${attempts}`;
    if (!timedOut && !isTransientElectronDownloadFailure(result.stderr ?? '')) {
      throw new Error(`${failure}; not a transient download error`);
    }
    if (attempt === attempts) {
      throw new Error(`${failure}; transient download retries exhausted`);
    }
    const delayMs = retryDelaysMs[attempt - 1];
    console.warn(
      `::warning::${failure} with a transient download error; retrying in ${delayMs}ms`,
    );
    sleepSync(delayMs);
  }
}

// The optional dependencies isolate tests; production callers remain synchronous.
export function ensureElectronBinaryInstalled({
  electronPackageJsonPath = require.resolve(
    ['electron', 'package.json'].join('/'),
  ),
  env = process.env,
  hostPlatform = process.platform,
  spawn = spawnSync,
  retryDelaysMs = ELECTRON_INSTALL_RETRY_DELAYS_MS,
  attemptTimeoutMs = ELECTRON_INSTALL_ATTEMPT_TIMEOUT_MS,
} = {}) {
  delete env.ELECTRON_EXEC_PATH;
  const platform =
    env.ELECTRON_INSTALL_PLATFORM || env.npm_config_platform || hostPlatform;
  const expectedRelativePath = getElectronPlatformPath(platform);
  const electronModuleDir = path.dirname(electronPackageJsonPath);
  const pathFile = path.join(electronModuleDir, 'path.txt');

  if (env.ELECTRON_OVERRIDE_DIST_PATH) {
    const relativePath = existsSync(pathFile)
      ? readFileSync(pathFile, 'utf8').trim() || expectedRelativePath
      : expectedRelativePath;
    const executable = path.join(env.ELECTRON_OVERRIDE_DIST_PATH, relativePath);
    if (!isFile(executable)) {
      throw new Error(
        `Electron override executable is missing or not a file: ${executable}`,
      );
    }
    env.ELECTRON_EXEC_PATH = executable;
    return;
  }

  const { version } = JSON.parse(readFileSync(electronPackageJsonPath, 'utf8'));
  const distRoot = path.join(electronModuleDir, 'dist');
  const inspect = () =>
    missingPieces(distRoot, expectedRelativePath, platform, version);
  const missing = inspect();
  if (missing.length) {
    if (env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
      throw new Error(
        `Electron repair disabled by ELECTRON_SKIP_BINARY_DOWNLOAD; missing: ${missing.join(', ')}`,
      );
    }

    // A stale path.txt must never advertise success after a failed repair.
    rmSync(pathFile, { force: true });
    let stage = 'download';
    let mutatedDist = false;
    const download = (args, stdout, resetDist = () => {}) =>
      runElectronInstaller(
        () =>
          spawn(process.execPath, args, {
            cwd: process.cwd(),
            env,
            encoding: 'utf8',
            stdio: ['ignore', stdout, 'pipe'],
            maxBuffer: 16 * 1024 * 1024,
            timeout: attemptTimeoutMs,
          }),
        resetDist,
        { retryDelaysMs, attemptTimeoutMs },
      );
    try {
      if (
        hostPlatform === 'darwin' &&
        (platform === 'darwin' || platform === 'mas')
      ) {
        const result = download(
          [
            fileURLToPath(
              new URL('./electron-download-artifact.mjs', import.meta.url),
            ),
            electronPackageJsonPath,
          ],
          'pipe',
        );
        let archive;
        try {
          archive = JSON.parse(result.stdout);
        } catch {
          throw new Error('download child returned malformed JSON');
        }
        if (
          !archive ||
          typeof archive.archivePath !== 'string' ||
          !path.isAbsolute(archive.archivePath) ||
          !isFile(archive.archivePath)
        ) {
          throw new Error(
            'download child did not return an existing absolute archive file',
          );
        }
        stage = 'extraction';
        mutatedDist = true;
        rmSync(distRoot, { recursive: true, force: true });
        run(spawn, 'ditto', ['-x', '-k', archive.archivePath, distRoot], {
          cwd: process.cwd(),
          env,
          stdio: 'inherit',
        });
      } else {
        stage = 'install';
        mutatedDist = true;
        download([path.join(electronModuleDir, 'install.js')], 'inherit', () =>
          rmSync(distRoot, { recursive: true, force: true }),
        );
      }
      stage = 'validation';
      const remaining = inspect();
      if (remaining.length) throw new Error(`missing: ${remaining.join(', ')}`);
      // Preserve install.js's handling of archives that include type definitions.
      const typeDefinitions = path.join(distRoot, 'electron.d.ts');
      if (isFile(typeDefinitions)) {
        renameSync(
          typeDefinitions,
          path.join(electronModuleDir, 'electron.d.ts'),
        );
      }
      stage = 'publication';
      writeFileSync(pathFile, expectedRelativePath);
    } catch (error) {
      const remaining = inspect();
      if (mutatedDist) rmSync(distRoot, { recursive: true, force: true });
      rmSync(pathFile, { force: true });
      throw new Error(
        `Electron binary ${stage} failed: ${error.message}; missing: ${remaining.join(', ') || missing.join(', ')}`,
        { cause: error },
      );
    }
  } else if (
    !existsSync(pathFile) ||
    readFileSync(pathFile, 'utf8') !== expectedRelativePath
  ) {
    writeFileSync(pathFile, expectedRelativePath);
  }
  env.ELECTRON_EXEC_PATH = path.join(distRoot, expectedRelativePath);
}
