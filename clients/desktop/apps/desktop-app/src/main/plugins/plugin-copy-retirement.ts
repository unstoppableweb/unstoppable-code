import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type PluginCacheIndex,
  readPluginCatalogAsync,
  readPluginCacheIndexAsync,
} from '@canopy/execution-engine/node/plugins/catalog-read-health';
import {
  pluginCopyPathIdentity as pathIdentity,
  pluginCopyProtectionIdentity as protectionIdentity,
  pluginCopyReferenceCollector as referenceCollector,
  isObservedPluginCopy,
} from '@canopy/execution-engine/node/plugins/plugin-copy-references';
import { getDataDir, getPluginCacheDir } from '../lib/paths';
import { publishPluginCachePair } from './plugin-catalog-store';
import {
  admitsPluginCopySweep,
  readClaudeMarketplaceRegistryEvidence,
  readPluginCopyJson,
  readPluginCopyProviderFile,
  reconfirmsPluginCopyEvidence,
  reconfirmsPluginCopyProviderAbsence,
  isPluginCopyEvidenceRecord,
  type PluginCopyEvidenceStamps,
  stampPluginCopyEvidencePath,
} from './plugin-copy-provider-evidence';

const processStartedAt = Date.now();
const minimumAgeMs = 60 * 60 * 1000;
const copyName = /^[A-Za-z0-9_-]+-[0-9a-f]{8}$/;

export function retirePluginCopies(
  index: PluginCacheIndex,
  paths: Iterable<string>,
): void {
  const retired = new Map<
    string,
    NonNullable<PluginCacheIndex['retired']>[number]
  >();
  for (const entry of index.retired ?? []) {
    const key = pathIdentity(entry.cachePath) ?? entry.cachePath;
    const previous = retired.get(key);
    // Unrelated retirements must not shorten a duplicate's grace or resolve an unknown age.
    if (
      !previous ||
      !Number.isFinite(Date.parse(entry.retiredAt)) ||
      Date.parse(entry.retiredAt) > Date.parse(previous.retiredAt)
    )
      retired.set(key, entry);
  }
  const retiredAt = new Date().toISOString();
  for (const cachePath of paths) {
    // A prior retirement may have survived rebinding. Defer from this removal,
    // not the first one, while this process can still hold the path in a session.
    retired.set(pathIdentity(cachePath) ?? cachePath, { cachePath, retiredAt });
  }
  index.retired = Array.from(retired.values());
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function damagedPreimageNames(): Promise<string[]> {
  return (await fs.promises.readdir(getDataDir()))
    .filter((name) =>
      /^(plugins-cache\.json|plugin-cache-index\.json)\.damaged-/.test(name),
    )
    .sort();
}

/** Called only in the existing serialized refresh, never on startup or on a read. */
export async function sweepRetiredPluginCopies(
  removeCopy: (candidate: string) => Promise<void>,
  claude: { installedPlugins: string; knownMarketplaces: string },
): Promise<void> {
  if (!admitsPluginCopySweep()) return;
  try {
    const managedRoot = getPluginCacheDir();
    // Never open a network cache root for destructive maintenance.
    if (/^[\\/]{2}/.test(managedRoot)) return;
    const cacheRoot = pathIdentity(managedRoot);
    if (!cacheRoot) return;
    const stamps: PluginCopyEvidenceStamps = new Map();
    const indexPath = path.join(getDataDir(), 'plugin-cache-index.json');
    const catalogPath = path.join(getDataDir(), 'plugins-cache.json');
    await Promise.all([
      stampPluginCopyEvidencePath(indexPath, stamps),
      stampPluginCopyEvidencePath(catalogPath, stamps),
    ]);
    const [indexHealth, catalogHealth] = await Promise.all([
      readPluginCacheIndexAsync(indexPath),
      readPluginCatalogAsync(catalogPath),
    ]);
    if (
      indexHealth.state !== 'valid' ||
      indexHealth.recovered ||
      catalogHealth.state !== 'valid' ||
      catalogHealth.recovered
    )
      return;
    const index = indexHealth.data;
    if (!index.retired?.length) return;
    const references = referenceCollector();
    references.collect(index, true);
    references.collect(catalogHealth.data);
    const installed = await readPluginCopyProviderFile(
      claude.installedPlugins,
      stamps,
    );
    if (installed.state === 'unknown') return;
    if (installed.state === 'present') references.collect(installed.value);
    const marketplaces = await readClaudeMarketplaceRegistryEvidence(
      claude.knownMarketplaces,
      stamps,
    );
    if (marketplaces.state === 'unknown') return;
    if (marketplaces.state === 'present')
      for (const document of marketplaces.value) references.collect(document);
    if (!(await reconfirmsPluginCopyProviderAbsence())) return;
    const preimages = await damagedPreimageNames();
    for (const name of preimages) {
      // An unreadable preimage might own any copy: leak rather than guess.
      const evidence = await readPluginCopyJson(
        path.join(getDataDir(), name),
        (value) =>
          isPluginCopyEvidenceRecord(value) &&
          (name.startsWith('plugin-cache-index.json')
            ? isPluginCopyEvidenceRecord(value.entries)
            : Array.isArray(value.marketplaces)),
        stamps,
      );
      // A listed preimage disappearing is not an affirmative empty inventory.
      if (evidence.state !== 'present') return;
      references.collect(evidence.value);
    }
    if (references.uncertain) return;
    const retired = new Map<string, number>();
    for (const entry of index.retired ?? []) {
      const key = pathIdentity(entry.cachePath);
      if (!key) continue;
      // A duplicate spelling must not shorten a newer grace period.
      retired.set(
        key,
        Math.max(retired.get(key) ?? -Infinity, Date.parse(entry.retiredAt)),
      );
    }
    const deleted = new Set<string>();
    const managedCopies = new Set<string>();
    const names = await fs.promises
      .readdir(cacheRoot)
      .catch((error: unknown) => {
        if (isMissingPath(error)) return [];
        throw error;
      });
    const identityCounts = new Map<string, number>();
    for (const name of names) {
      const identity = pathIdentity(path.join(cacheRoot, name));
      if (!identity) continue;
      const key = protectionIdentity(identity);
      identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
    }
    for (const name of names) {
      if (!copyName.test(name)) continue;
      const candidate = path.join(cacheRoot, name);
      const key = pathIdentity(candidate);
      if (!key || !retired.has(key)) continue;
      const stat = await fs.promises
        .lstat(candidate)
        .catch((error: unknown) => {
          if (isMissingPath(error)) return undefined;
          throw error;
        });
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
      managedCopies.add(key);
      // Case-sensitive volumes can hold distinct children with one folded key.
      const protectedKey = protectionIdentity(key);
      if (identityCounts.get(protectedKey) !== 1) continue;
      // Inbound cache aliases are unsupported: never realpath untrusted catalog paths.
      if (references.protects(candidate)) continue;
      const timestamp = retired.get(key);
      if (timestamp === undefined) continue;
      if (
        !Number.isFinite(timestamp) ||
        timestamp >= processStartedAt ||
        Date.now() - timestamp < minimumAgeMs
      )
        continue;
      // Admission, rechecked before each deletion: every evidence file read above
      // keeps its read-time stamp (absent stays absent, same damaged preimages) and an
      // absent Codex is still absent; any change or error ends this cycle's deletions.
      // A copy that process history names is kept. A complete Codex listing is
      // a provider answer, judged once per refresh. Unseen by design: a same-size
      // rewrite within one timestamp tick, and a writer that names the copy after
      // this check or during removal; it works from older state, which the grace
      // period and earlier-lifetime rule bound (CAN-7843).
      if (
        !(await reconfirmsPluginCopyEvidence(
          stamps,
          async () =>
            (await damagedPreimageNames()).join('\n') === preimages.join('\n'),
        )) ||
        !admitsPluginCopySweep() ||
        isObservedPluginCopy(candidate)
      )
        continue;
      try {
        await removeCopy(candidate);
        deleted.add(key);
      } catch (error) {
        process.stderr.write(
          `[plugins] Leaving plugin copy in place (${candidate}): ${String(error)}\n`,
        );
      }
    }
    const retained = index.retired?.filter((entry) => {
      const candidate = pathIdentity(entry.cachePath);
      return (
        candidate !== undefined &&
        managedCopies.has(candidate) &&
        !deleted.has(candidate)
      );
    });
    if (retained?.length !== index.retired?.length) {
      index.retired = retained;
      await publishPluginCachePair(index);
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return;
    process.stderr.write(
      `[plugins] Skipping plugin copy sweep: ${String(error)}\n`,
    );
  }
}
