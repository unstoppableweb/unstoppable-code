/** Build-time payload checks only; these receipts are not load-time authorization. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isX64PeImage, stripPeAuthenticodeSignature } from './pe-signature.mjs';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DAEMON_SECRET_PROTECTION_FILE as ADDON,
  DAEMON_SECRET_PROTECTION_RECEIPT as RECEIPT,
  DAEMON_SECRET_PROTECTION_MEMBERS,
} from '../../packages/core-platform/src/execution-host/daemon-payload.ts';
import { binaryArchitecture } from './daemon-node-pty.mjs';
import { hashFile } from './core-daemon-sources.mjs';

const TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'linux-x64',
  'linux-arm64',
]);

export function assertSecretProtectionTarget(
  target,
  host = `${process.platform}-${process.arch}`,
) {
  if (
    !TARGETS.has(target) ||
    (target !== host &&
      !(target.startsWith('darwin-') && host.startsWith('darwin-')))
  )
    throw new Error(`Native vault payload ${target} cannot build on ${host}`);
}

export function assertSecretProtectionBinary(path, target) {
  if (!TARGETS.has(target))
    throw new Error(`Unsupported native vault target ${target}`);
  if (!lstatSync(path).isFile())
    throw new Error(`Native vault payload is not a regular file: ${path}`);
  const bytes = readFileSync(path);
  const [platform, arch] = target.split('-');
  const native = binaryArchitecture(bytes);
  const format = { darwin: 'mach-o', win32: 'pe', linux: 'elf' }[platform];
  if (native?.format !== format || !native.arches.includes(arch))
    throw new Error(
      `Native vault payload has wrong format/architecture for ${target}: ${path}`,
    );
  if (
    platform === 'darwin' &&
    (!native.arches.includes('arm64') || !native.arches.includes('x64'))
  )
    throw new Error(`Native vault payload must be universal: ${path}`);
  if (
    platform === 'linux' &&
    (bytes.length < 64 || bytes.readUInt16LE(16) !== 3)
  )
    throw new Error(
      `Native vault payload must be an ELF shared object: ${path}`,
    );
  if (platform === 'win32') {
    if (!isX64PeImage(bytes))
      throw new Error(
        `Native vault payload must be an x64 PE32+ image: ${path}`,
      );
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.length < pe + 24 || (bytes.readUInt16LE(pe + 22) & 0x2000) === 0)
      throw new Error(`Native vault payload must be a PE DLL: ${path}`);
  }
  if (platform !== 'win32' && (lstatSync(path).mode & 0o7777) !== 0o644)
    throw new Error(`Native vault payload must have mode 0644: ${path}`);
}

function imageDigest(path) {
  const bytes = readFileSync(path);
  const image = Buffer.from(stripPeAuthenticodeSignature(bytes).buffer);
  image.writeUInt32LE(0, bytes.readUInt32LE(0x3c) + 24 + 64);
  return createHash('sha256').update(image).digest('hex');
}

export function clearSecretProtection(directory) {
  for (const name of DAEMON_SECRET_PROTECTION_MEMBERS)
    rmSync(join(directory, name), { force: true });
}

/** A failure leaves no old or partially staged member for packaging to accept. */
export function stageSecretProtection({ source, destination, target }) {
  clearSecretProtection(destination);
  try {
    assertSecretProtectionBinary(source, target);
    mkdirSync(destination, { recursive: true });
    const output = join(destination, ADDON);
    copyFileSync(source, output);
    chmodSync(output, 0o644);
    writeFileSync(
      join(destination, RECEIPT),
      `${JSON.stringify({ schema: 1, target, sha256: hashFile(output), ...(target.startsWith('win32-') ? { imageSha256: imageDigest(output) } : {}) }, null, 2)}\n`,
      { mode: 0o644 },
    );
    assertStagedSecretProtection(destination, target);
    return output;
  } catch (error) {
    clearSecretProtection(destination);
    throw error;
  }
}

export function assertStagedSecretProtection(
  directory,
  target,
  { signed = false } = {},
) {
  const receiptPath = join(directory, RECEIPT);
  if (!lstatSync(receiptPath).isFile())
    throw new Error(
      `Native vault receipt is not a regular file: ${receiptPath}`,
    );
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (
    receipt.schema !== 1 ||
    receipt.target !== target ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')
  )
    throw new Error(`Invalid native vault payload receipt for ${target}`);
  const addon = join(directory, ADDON);
  assertSecretProtectionBinary(addon, target);
  if (
    target.startsWith('win32-') &&
    (!/^[a-f0-9]{64}$/.test(receipt.imageSha256 ?? '') ||
      imageDigest(addon) !== receipt.imageSha256)
  )
    throw new Error(`Native vault payload image hash mismatch: ${addon}`);
  if (!signed && hashFile(addon) !== receipt.sha256)
    throw new Error(`Native vault payload hash mismatch: ${addon}`);
}

/** Check every universal slice; default codesign display only checks the host slice. */
export function assertSignedSecretProtection({
  daemonPath,
  target,
  readEntitlements,
  codesign = (args) =>
    spawnSync('codesign', args, { encoding: 'utf8', timeout: 60_000 }),
}) {
  const directory = dirname(daemonPath);
  assertStagedSecretProtection(directory, target, { signed: true });
  const addon = join(directory, ADDON);
  const run = (args) => {
    const result = codesign(args);
    if (result.error || result.status !== 0)
      throw new Error(
        `Native vault signature check failed: ${result.error?.message ?? result.stderr}`,
      );
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
  };
  const team = (path, arch) => {
    const text = run([
      '-d',
      '--verbose=2',
      ...(arch ? ['--arch', arch] : []),
      path,
    ]);
    const id = /^TeamIdentifier=(.+)$/m.exec(text)?.[1];
    if (!id || (id === 'not set' && !/^Signature=adhoc$/m.test(text)))
      throw new Error(`Missing native vault signing identity: ${path}`);
    const flags = /^CodeDirectory .*flags=0x([0-9a-f]+)/m.exec(text)?.[1];
    return {
      id,
      adhoc: /^Signature=adhoc$/m.test(text),
      runtime: (Number.parseInt(flags ?? '0', 16) & 0x10000) !== 0,
    };
  };
  run(['--verify', '--strict', daemonPath]);
  const daemon = team(daemonPath);
  for (const arch of ['arm64', 'x86_64']) {
    run(['--verify', '--strict', '--arch', arch, addon]);
    const facts = team(addon, arch);
    if (facts.id !== daemon.id || facts.adhoc !== daemon.adhoc)
      throw new Error(`Native vault Team ID mismatch (${arch})`);
    if (daemon.runtime && !facts.runtime)
      throw new Error(`Native vault lacks hardened runtime (${arch})`);
    if (Object.keys(readEntitlements(addon, arch)).length !== 0)
      throw new Error(
        `Native vault addon must grant no entitlements (${arch})`,
      );
  }
}
