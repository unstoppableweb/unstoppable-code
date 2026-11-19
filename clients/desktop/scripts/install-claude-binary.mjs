#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CLAUDE_TARGETS } from './lib/binary-staging-assets.mjs';
import {
  cleanupTempPaths,
  downloadToFile,
  finalizeStagedBinary,
  getBinaryCacheRoot,
  getRepoRootFromScriptsLib,
  isAlreadyStaged,
  parseTargetArgs,
  readPinnedPackageVersion,
  resolveTargets,
  executableName,
  sha256File,
  writeVersionMarker,
} from './lib/binary-staging-utils.mjs';

const BUCKET_URL =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';

const root = getRepoRootFromScriptsLib();
const cacheRoot = getBinaryCacheRoot(root);

// The manifest goes through the same retrying downloader as the binary, so a
// transient network or server failure retries instead of failing the stage.
async function fetchJson(url) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-manifest-'));
  try {
    const manifestPath = join(directory, 'manifest.json');
    await downloadToFile(url, manifestPath);
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function stageTarget(version, manifest, target) {
  const metadata = manifest.platforms?.[target];
  if (!metadata || typeof metadata !== 'object') {
    throw new Error(`Target "${target}" not found in Claude manifest`);
  }

  const binaryName =
    typeof metadata.binary === 'string' && metadata.binary.length > 0
      ? metadata.binary
      : executableName('claude', target);
  const checksum = metadata.checksum;
  if (typeof checksum !== 'string' || checksum.length === 0) {
    throw new Error(`Target "${target}" is missing a checksum in the manifest`);
  }

  const targetDir = join(cacheRoot, target);
  const finalPath = join(targetDir, binaryName);
  const versionMarkerPath = join(targetDir, '.claude-version');
  mkdirSync(targetDir, { recursive: true });

  if (isAlreadyStaged(finalPath, versionMarkerPath, version, checksum)) {
    console.log(`Claude ${target} already staged at ${finalPath}`);
    return finalPath;
  }

  if (existsSync(finalPath)) {
    const existingChecksum = await sha256File(finalPath);
    if (existingChecksum === checksum) {
      writeVersionMarker(versionMarkerPath, version, checksum);
      console.log(`Claude ${target} already staged at ${finalPath}`);
      return finalPath;
    }
  }

  const tempPath = join(
    targetDir,
    `${basename(finalPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  const downloadUrl = `${BUCKET_URL}/${version}/${target}/${binaryName}`;

  try {
    console.log(`Downloading Claude ${target}...`);
    await downloadToFile(downloadUrl, tempPath);
    const downloadedChecksum = await sha256File(tempPath);
    if (downloadedChecksum !== checksum) {
      throw new Error(
        `Checksum mismatch for ${target}: expected ${checksum}, received ${downloadedChecksum}`,
      );
    }
    return finalizeStagedBinary({
      extractedBinary: tempPath,
      finalPath,
      markerPath: versionMarkerPath,
      version,
      checksum,
      label: 'Claude',
      target,
    });
  } finally {
    cleanupTempPaths([tempPath]);
  }
}

async function main() {
  const args = parseTargetArgs(process.argv.slice(2));
  const targets = resolveTargets(args, 'Claude', {
    supportedTargets: CLAUDE_TARGETS,
  });

  if (targets.length === 0) {
    console.log(
      'No Claude binaries staged: no explicit targets and host platform is unsupported.',
    );
    return;
  }

  const version = readPinnedPackageVersion(root, 'claude-code.version');
  const manifest = await fetchJson(`${BUCKET_URL}/${version}/manifest.json`);

  for (const target of targets) {
    await stageTarget(version, manifest, target);
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
