/** Exact final-byte pins relative to the trusted daemon, not adjacent receipts. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  NATIVE_CATALOG_PREFIX,
  NATIVE_CATALOG_SUFFIX,
  NATIVE_VAULT_FILE,
  NATIVE_DEPENDENCY_POLICIES,
  isNativeArtifactCatalog,
} from '../../packages/core-platform/src/secret-protection/catalog.ts';
import { assertSecretProtectionBinary } from './daemon-secret-protection.mjs';
import { assertNativeVaultDependencies } from './native-vault-dependencies.mjs';

const MAX_CATALOG_BYTES = 8192;

export function createNativeVaultCatalog({
  file,
  target,
  identity,
  version,
  generation = randomUUID(),
}) {
  const [platform, architecture] = target.split('-');
  if (!Object.hasOwn(NATIVE_DEPENDENCY_POLICIES, platform))
    throw new Error(`Unsupported native vault platform ${platform}`);
  if (file) {
    assertSecretProtectionBinary(file, target);
    assertNativeVaultDependencies(file, target);
  }
  const bytes = file ? readFileSync(file) : null;
  const catalog = {
    schema: 1,
    generation,
    brandId: identity.productIdentity.brandId,
    build: identity.productIdentity.build,
    version,
    buildId: identity.buildId,
    member: {
      id: 'vault-key-slots',
      filename: NATIVE_VAULT_FILE,
      platform,
      architectures: platform === 'darwin' ? ['arm64', 'x64'] : [architecture],
      compatibility: 'node-api-8-product-v1',
      dependencyPolicy: NATIVE_DEPENDENCY_POLICIES[platform],
      ...(bytes
        ? {
            state: 'present',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }
        : { state: 'absent', reason: 'development-toolchain-unavailable' }),
    },
  };
  if (!isNativeArtifactCatalog(catalog))
    throw new Error('Invalid native vault build catalog.');
  return catalog;
}

export function encodeNativeVaultCatalog(catalog) {
  if (!isNativeArtifactCatalog(catalog))
    throw new Error('Invalid native vault catalog.');
  return `${NATIVE_CATALOG_PREFIX}${Buffer.from(JSON.stringify(catalog)).toString('base64')}${NATIVE_CATALOG_SUFFIX}`;
}

export function readDaemonNativeVaultCatalog(daemonPath) {
  return readNativeVaultCatalogBytes(readFileSync(daemonPath));
}

function* nativeVaultCatalogValues(bytes) {
  const prefix = Buffer.from(NATIVE_CATALOG_PREFIX);
  const suffix = Buffer.from(NATIVE_CATALOG_SUFFIX);
  for (
    let at = bytes.indexOf(prefix);
    at !== -1;
    at = bytes.indexOf(prefix, at + prefix.length)
  ) {
    const end = bytes.indexOf(suffix, at + prefix.length);
    if (end === -1 || end - at > MAX_CATALOG_BYTES) continue;
    const encoded = bytes.subarray(at + prefix.length, end).toString('ascii');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
    const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (!isNativeArtifactCatalog(value))
      throw new Error('Invalid compiled native vault catalog.');
    yield value;
  }
}

function matchingCatalog(prior, value) {
  // V8's code cache can repeat the same string; conflicting anchors always refuse.
  if (prior && JSON.stringify(prior) !== JSON.stringify(value))
    throw new Error('Missing or contradictory compiled native vault catalog.');
  return value;
}

function requireCatalog(value) {
  if (!value)
    throw new Error('Missing or contradictory compiled native vault catalog.');
  return value;
}

export function readNativeVaultCatalogBytes(bytes) {
  let catalog;
  for (const value of nativeVaultCatalogValues(bytes))
    catalog = matchingCatalog(catalog, value);
  return requireCatalog(catalog);
}

/** Archive streams avoid whole-file/range limits, including for large SEAs. */
export async function readNativeVaultCatalogEntry(entry) {
  let catalog;
  let tail = Buffer.alloc(0);
  let length = 0;
  const digest = createHash('sha256');
  for await (const chunk of entry.openReadStream()) {
    length += chunk.length;
    digest.update(chunk);
    const bytes = Buffer.concat([tail, chunk]);
    for (const value of nativeVaultCatalogValues(bytes))
      catalog = matchingCatalog(catalog, value);
    // Keep every possible bounded anchor, even across chunk boundaries.
    tail = Buffer.from(
      bytes.subarray(
        -(MAX_CATALOG_BYTES + Buffer.byteLength(NATIVE_CATALOG_SUFFIX)),
      ),
    );
  }
  if (length !== entry.size || digest.digest('hex') !== entry.sha256)
    throw new Error('File bytes changed during native catalog inspection.');
  return requireCatalog(catalog);
}

export function assertFinalNativeVaultBytes({
  daemonPath,
  target,
  directory = dirname(daemonPath),
}) {
  const catalog = readDaemonNativeVaultCatalog(daemonPath);
  const [platform, arch] = target.split('-');
  const member = catalog.member;
  if (
    member.state !== 'present' ||
    member.platform !== platform ||
    !member.architectures.includes(arch)
  )
    throw new Error(
      'Final package requires a present native vault member for its target.',
    );
  const file = join(directory, NATIVE_VAULT_FILE);
  assertSecretProtectionBinary(file, target);
  const bytes = readFileSync(file);
  if (
    bytes.length !== member.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== member.sha256
  )
    throw new Error(
      'Final native vault bytes differ from the daemon compiled expectation.',
    );
  return catalog;
}
