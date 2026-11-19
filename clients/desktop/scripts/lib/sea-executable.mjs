// Node single-executable (SEA) steps shared by the CLI and core daemon builds.
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { stripPeAuthenticodeSignature } from './pe-signature.mjs';

const require = createRequire(import.meta.url);

export function detectSentinelFuse(nodeBinaryPath) {
  const bytes = readFileSync(nodeBinaryPath);
  const fuseMatch = bytes.toString('latin1').match(/NODE_SEA_FUSE_[a-f0-9]+/);
  if (!fuseMatch) {
    throw new Error(
      'Could not detect NODE_SEA_FUSE sentinel in the node binary. ' +
        'Ensure your Node.js build supports Single Executable Applications.',
    );
  }

  return fuseMatch[0];
}

function getPostjectCliPath() {
  const packageJsonPath = require.resolve('postject/package.json');
  const packageJson = require(packageJsonPath);
  const { bin } = packageJson;
  const cliRelativePath =
    typeof bin === 'string'
      ? bin
      : bin && typeof bin === 'object'
        ? (bin.postject ?? Object.values(bin)[0])
        : null;

  if (typeof cliRelativePath !== 'string' || cliRelativePath.length === 0) {
    throw new Error(
      'Unable to determine postject CLI path from package.json bin field',
    );
  }

  return join(dirname(packageJsonPath), cliRelativePath);
}

/**
 * SEA options that refuse SIGUSR1 inspector activation and every runtime
 * Node-option source (NODE_OPTIONS and `--node-options`).
 */
export const CLOSED_SEA_RUNTIME = Object.freeze({
  execArgv: Object.freeze(['--disable-sigusr1']),
  execArgvExtension: 'none',
});

// The building Node becomes the packaged daemon runtime. Keep closed-SEA
// support and require a supported line patched for CVE-2026-111497.
const CLOSED_SEA_NODE_FLOORS = new Map([
  [24, [22, 1]],
  [26, [12, 1]],
]);

/** Throws unless `version` is a supported, patched closed-SEA runtime. */
export function assertClosedSeaNode(version) {
  const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const floor = parts && CLOSED_SEA_NODE_FLOORS.get(parts[0]);
  if (
    !floor ||
    parts[1] < floor[0] ||
    (parts[1] === floor[0] && parts[2] < floor[1])
  )
    throw new Error(
      `Closed SEA builds need patched Node 24.22.1 or 26.12.1 (or a newer patch/minor on those lines); found ${version || 'no version'}.`,
    );
}

/** Writes the SEA config for `main` and generates its blob. */
export function generateSeaBlob({
  main,
  blobPath,
  configPath,
  useCodeCache,
  useSnapshot,
  execArgv,
  execArgvExtension,
  nodeBinaryPath = process.execPath,
  timeoutMs,
  cwd,
}) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        main,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useCodeCache,
        ...(useSnapshot === undefined ? {} : { useSnapshot }),
        ...(execArgv === undefined ? {} : { execArgv }),
        ...(execArgvExtension === undefined ? {} : { execArgvExtension }),
      },
      null,
      2,
    ),
  );
  execFileSync(nodeBinaryPath, ['--experimental-sea-config', configPath], {
    cwd,
    stdio: 'inherit',
    ...(timeoutMs === undefined
      ? {}
      : { timeout: timeoutMs, killSignal: 'SIGKILL' }),
  });
}

/**
 * Copies `baseNodePath` to `outputPath` and injects the blob. Strips the
 * Windows Authenticode signature first; on a macOS host, re-signs ad hoc.
 */
export function buildSeaBinary({
  baseNodePath,
  outputPath,
  target,
  blobPath,
  nodeBinaryPath = process.execPath,
  timeoutMs,
  cwd,
}) {
  rmSync(outputPath, { force: true });
  cpSync(baseNodePath, outputPath);

  if (target.startsWith('win32-')) {
    const { buffer, removedCertificateSize } = stripPeAuthenticodeSignature(
      readFileSync(outputPath),
    );
    if (removedCertificateSize > 0) {
      writeFileSync(outputPath, buffer);
      console.log(
        `Removed ${removedCertificateSize} bytes of Authenticode signature data before SEA injection`,
      );
    }
  }

  if (target.startsWith('darwin-') && process.platform === 'darwin') {
    execFileSync('codesign', ['--remove-signature', outputPath], {
      stdio: 'inherit',
    });
  }

  const postjectArgs = [
    outputPath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    detectSentinelFuse(baseNodePath),
  ];

  if (target.startsWith('darwin-')) {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }

  execFileSync(nodeBinaryPath, [getPostjectCliPath(), ...postjectArgs], {
    cwd,
    stdio: 'inherit',
    ...(timeoutMs === undefined
      ? {}
      : { timeout: timeoutMs, killSignal: 'SIGKILL' }),
  });

  if (target.startsWith('darwin-') && process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', outputPath], {
      stdio: 'inherit',
    });
  }
}
