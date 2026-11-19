import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  downloadToFile,
  extractTarGz,
  extractZip,
  sha256File,
} from './binary-staging-utils.mjs';
import { assertCliExecutable } from './cli-executable.mjs';

const LINUX_TARGETS = new Set(['linux-x64', 'linux-arm64']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NODE_DISTRIBUTIONS = Object.freeze({
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'win32-x64': 'win-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
});

export function getLinuxNodeDistribution(packageJson, target) {
  if (!LINUX_TARGETS.has(target)) {
    throw new Error(`Unsupported CLI Node distribution target: ${target}`);
  }
  return getPinnedNodeDistribution(packageJson, target);
}

export function getPinnedNodeDistribution(packageJson, target) {
  const nodeDist = NODE_DISTRIBUTIONS[target];
  if (!nodeDist)
    throw new Error(`Unsupported Node distribution target: ${target}`);
  const pin = packageJson?.['cli-node'];
  if (typeof pin?.version !== 'string' || !VERSION_PATTERN.test(pin.version)) {
    throw new Error(
      'package.json cli-node.version must be a numeric Node version',
    );
  }
  const archiveSha256 = pin.artifacts?.[target]?.sha256;
  if (
    typeof archiveSha256 !== 'string' ||
    !SHA256_PATTERN.test(archiveSha256)
  ) {
    throw new Error(
      `package.json cli-node.artifacts.${target}.sha256 must be 64 lowercase hexadecimal characters`,
    );
  }

  const version = `v${pin.version}`;
  const archiveName = `node-${version}-${nodeDist}.${target === 'win32-x64' ? 'zip' : 'tar.gz'}`;
  return {
    version,
    nodeDist: target,
    archiveName,
    archiveUrl: `https://nodejs.org/dist/${version}/${archiveName}`,
    archiveSha256,
  };
}

function validateDistribution(distribution) {
  const target = distribution?.nodeDist;
  const expected = getPinnedNodeDistribution(
    {
      'cli-node': {
        version:
          typeof distribution?.version === 'string' &&
          distribution.version.startsWith('v')
            ? distribution.version.slice(1)
            : null,
        artifacts: { [target]: { sha256: distribution?.archiveSha256 } },
      },
    },
    target,
  );
  if (distribution.archiveName !== expected.archiveName) {
    throw new Error('Invalid Node distribution target or archive name');
  }
  const url = new URL(distribution.archiveUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Linux Node distribution requires an HTTP(S) archive URL');
  }
}

async function isValidCache(
  nodePath,
  receiptPath,
  distribution,
  requireLicense = false,
) {
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.target !== distribution.nodeDist ||
      receipt.version !== distribution.version ||
      receipt.archiveName !== distribution.archiveName ||
      receipt.archiveSha256 !== distribution.archiveSha256 ||
      typeof receipt.nodeSha256 !== 'string' ||
      !SHA256_PATTERN.test(receipt.nodeSha256) ||
      !lstatSync(nodePath).isFile()
    ) {
      return false;
    }
    assertPinnedNodeExecutable(
      distribution.nodeDist,
      readFileSync(nodePath),
      nodePath,
    );
    if (requireLicense) {
      const license = join(dirname(nodePath), 'LICENSE');
      if (
        !lstatSync(license).isFile() ||
        typeof receipt.licenseSha256 !== 'string' ||
        (await sha256File(license)) !== receipt.licenseSha256
      )
        return false;
    }
    return (await sha256File(nodePath)) === receipt.nodeSha256;
  } catch {
    return false;
  }
}

function removePublication(nodePath, receiptPath) {
  rmSync(nodePath, { recursive: true, force: true });
  rmSync(receiptPath, { recursive: true, force: true });
}

export async function ensureLinuxNodeBinary({ nodeCacheRoot, distribution }) {
  if (!LINUX_TARGETS.has(distribution?.nodeDist))
    throw new Error('Expected a Linux Node distribution');
  return ensurePinnedNodeBinary({ nodeCacheRoot, distribution });
}

/** Verified upstream bytes; receipts are invalidated before a failed publication. */
export async function ensurePinnedNodeBinary({
  nodeCacheRoot,
  distribution,
  requireLicense = false,
}) {
  validateDistribution(distribution);
  const target = distribution.nodeDist;
  const windows = target === 'win32-x64';
  const targetDir = join(nodeCacheRoot, distribution.version, target);
  const nodePath = join(targetDir, windows ? 'node.exe' : 'node');
  const receiptPath = join(targetDir, '.node-distribution.json');
  if (await isValidCache(nodePath, receiptPath, distribution, requireLicense)) {
    chmodSync(nodePath, 0o755);
    console.log(
      `Reusing verified Node.js ${distribution.version} ${target} at ${nodePath}`,
    );
    return nodePath;
  }

  removePublication(nodePath, receiptPath);
  mkdirSync(targetDir, { recursive: true });
  const tempDir = mkdtempSync(join(targetDir, '.node-runtime-'));
  const archivePath = join(tempDir, distribution.archiveName);
  const extractDir = join(tempDir, 'extract');
  const extractedNodePath = join(
    extractDir,
    `node-${distribution.version}-${NODE_DISTRIBUTIONS[target]}`,
    ...(windows ? ['node.exe'] : ['bin', 'node']),
  );

  try {
    console.log(
      `Downloading pinned Node.js ${distribution.version} ${target}…`,
    );
    await downloadToFile(distribution.archiveUrl, archivePath);
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== distribution.archiveSha256) {
      throw new Error(
        `SHA256 mismatch for ${distribution.archiveName}: expected ${distribution.archiveSha256}, got ${actualSha256}`,
      );
    }
    console.log(`SHA256 verified for ${distribution.archiveName}`);

    mkdirSync(extractDir);
    if (windows) await extractZip(archivePath, extractDir);
    else extractTarGz(archivePath, extractDir);
    let extractedStat;
    try {
      extractedStat = lstatSync(extractedNodePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      throw new Error(
        `Expected extracted Node binary not found at ${extractedNodePath}`,
      );
    }
    if (!extractedStat.isFile()) {
      throw new Error(
        `Expected extracted Node binary to be a regular file at ${extractedNodePath}`,
      );
    }
    assertPinnedNodeExecutable(
      target,
      readFileSync(extractedNodePath),
      extractedNodePath,
    );
    const nodeSha256 = await sha256File(extractedNodePath);
    let licenseSha256;
    if (requireLicense) {
      const source = join(
        extractDir,
        `node-${distribution.version}-${NODE_DISTRIBUTIONS[target]}`,
        'LICENSE',
      );
      if (!lstatSync(source).isFile())
        throw new Error('Missing upstream Node LICENSE');
      licenseSha256 = await sha256File(source);
      cpSync(source, join(tempDir, 'LICENSE'));
    }
    chmodSync(extractedNodePath, 0o755);
    const tempReceiptPath = join(tempDir, '.node-distribution.json');
    writeFileSync(
      tempReceiptPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          target,
          version: distribution.version,
          archiveName: distribution.archiveName,
          archiveSha256: distribution.archiveSha256,
          nodeSha256,
          ...(requireLicense ? { licenseSha256 } : {}),
        },
        null,
        2,
      )}\n`,
    );
    renameSync(extractedNodePath, nodePath);
    if (requireLicense)
      renameSync(join(tempDir, 'LICENSE'), join(targetDir, 'LICENSE'));
    // The receipt is the publication marker; an interrupted Node rename alone
    // must never make an unverified runtime reusable.
    renameSync(tempReceiptPath, receiptPath);
    console.log(`Staged verified Node.js ${target} at ${nodePath}`);
    return nodePath;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Plain upstream Node is thin Mach-O or PE x64, never a universal SEA. */
export function assertPinnedNodeExecutable(target, bytes, label) {
  assertCliExecutable(target, bytes, label);
  if (target.startsWith('darwin-')) {
    const cpu = target === 'darwin-arm64' ? 0x0100000c : 0x01000007;
    if (
      bytes.length < 32 ||
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== cpu
    )
      throw new Error(`Wrong Node Mach-O architecture at ${label} (${target})`);
  } else if (target === 'win32-x64') {
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length;
    if (
      offset > bytes.length - 26 ||
      bytes.toString('hex', offset, offset + 4) !== '50450000' ||
      bytes.readUInt16LE(offset + 4) !== 0x8664 ||
      bytes.readUInt16LE(offset + 24) !== 0x20b
    )
      throw new Error(`Wrong Node PE architecture at ${label} (${target})`);
  }
}

const OFFICIAL_NODE_DISTRIBUTIONS = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'win32-x64': 'win-x64',
};

/**
 * This Node's version from nodejs.org for a macOS or Windows target, checked
 * against the release's SHASUMS256.txt and cached under
 * `<nodeCacheRoot>/<version>/<dist>/`. The CLI and core daemon cross-builds
 * share the cache.
 */
export async function ensureOfficialNodeBinary({
  nodeCacheRoot,
  target,
  label,
}) {
  const nodeDist = OFFICIAL_NODE_DISTRIBUTIONS[target];
  if (!nodeDist) {
    throw new Error(`Unsupported ${label} staging target: ${target}`);
  }
  const windows = target.startsWith('win32-');
  const version = process.version;
  const cachedNodePath = join(
    nodeCacheRoot,
    version,
    nodeDist,
    windows ? 'node.exe' : 'node',
  );
  if (existsSync(cachedNodePath)) {
    return cachedNodePath;
  }

  const extension = windows ? 'zip' : 'tar.gz';
  const unique = `${process.pid}-${Date.now()}`;
  const tempExtractDir = join(nodeCacheRoot, `extract-${nodeDist}-${unique}`);
  const tempArchivePath = join(
    nodeCacheRoot,
    `node-${nodeDist}-${unique}.${extension}`,
  );
  const archiveName = `node-${version}-${nodeDist}.${extension}`;
  const archiveUrl = `https://nodejs.org/dist/${version}/${archiveName}`;
  const extractedNodePath = windows
    ? join(tempExtractDir, `node-${version}-${nodeDist}`, 'node.exe')
    : join(tempExtractDir, `node-${version}-${nodeDist}`, 'bin', 'node');
  const temporaryNodePath = `${cachedNodePath}.tmp-${unique}`;

  mkdirSync(join(nodeCacheRoot, version), { recursive: true });

  try {
    console.log(`Downloading Node.js ${nodeDist} for ${label} staging…`);
    await downloadToFile(archiveUrl, tempArchivePath);

    const sumsUrl = `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
    const sumsResponse = await fetch(sumsUrl, { redirect: 'follow' });
    if (!sumsResponse.ok) {
      throw new Error(
        `Failed to fetch SHASUMS256.txt (${sumsResponse.status})`,
      );
    }
    const sumsText = await sumsResponse.text();
    const entry = sumsText
      .split('\n')
      .find((l) => l.trim().endsWith(archiveName));
    if (!entry) {
      throw new Error(`No checksum entry for ${archiveName} in SHASUMS256.txt`);
    }
    const expectedSha = entry.trim().split(/\s+/)[0];
    const actualSha = await sha256File(tempArchivePath);
    if (actualSha !== expectedSha) {
      throw new Error(
        `SHA256 mismatch for ${archiveName}: expected ${expectedSha}, got ${actualSha}`,
      );
    }
    console.log(`SHA256 verified for ${archiveName}`);

    mkdirSync(tempExtractDir, { recursive: true });
    if (windows) {
      await extractZip(tempArchivePath, tempExtractDir);
    } else {
      extractTarGz(tempArchivePath, tempExtractDir);
    }

    if (!existsSync(extractedNodePath)) {
      throw new Error(
        `Expected extracted Node binary not found at ${extractedNodePath}`,
      );
    }

    mkdirSync(dirname(cachedNodePath), { recursive: true });
    // Publish by rename: an interrupted copy must never become the cache.
    cpSync(extractedNodePath, temporaryNodePath);
    renameSync(temporaryNodePath, cachedNodePath);
    return cachedNodePath;
  } finally {
    rmSync(temporaryNodePath, { force: true });
    rmSync(tempArchivePath, { force: true });
    rmSync(tempExtractDir, { recursive: true, force: true });
  }
}

// Preserve the x64-only acceptance harness API while sharing pin/cache handling.
export function getLinuxX64NodeDistribution(packageJson) {
  return getLinuxNodeDistribution(packageJson, 'linux-x64');
}

export async function ensureLinuxX64NodeBinary(options) {
  if (options.distribution?.nodeDist !== 'linux-x64') {
    throw new Error('Expected Linux x64 Node distribution');
  }
  return ensureLinuxNodeBinary(options);
}
