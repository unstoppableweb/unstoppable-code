import { AsyncLocalStorage } from 'node:async_hooks';
import { join, resolve } from 'node:path';
import {
  assertAdmittedWriter,
  STORAGE_OWNERSHIP,
  StorageOutcomeUnknownError,
} from '@canopy/core-runtime/storage';
import {
  createDirectoryDurably,
  writeFileAtomically,
  type AdmittedWriterTarget,
} from '@canopy/execution-engine/node/lib/atomic-file';
import {
  decodePluginCatalog,
  decodePluginCacheIndex,
  readPluginCatalog,
  readPluginCacheIndex,
  type PluginCacheIndex,
} from '@canopy/execution-engine/node/plugins/catalog-read-health';
import type { PluginsCache } from '@canopy/execution-engine/types/plugins';
import { getDataDir } from '../lib/paths';

export function readPluginCatalogHealth(): ReturnType<
  typeof readPluginCatalog
> {
  return readPluginCatalog(join(getDataDir(), 'plugins-cache.json'));
}

export function readPluginIndexHealth(): ReturnType<
  typeof readPluginCacheIndex
> {
  return readPluginCacheIndex(join(getDataDir(), 'plugin-cache-index.json'));
}

const MODULE = 'main/plugins/plugin-catalog-store';
const generations = new Map<string, number>();
export interface CatalogObservation {
  readonly root: string;
  readonly generation: number;
}
export type CatalogPublicationOutcome = {
  readonly document: 'plugins_cache' | 'plugin_cache_index';
  readonly state: 'not_installed' | 'durable' | 'installed_uncertain';
  readonly committed?: PluginsCache | PluginCacheIndex;
  readonly installedCandidate?: PluginsCache | PluginCacheIndex;
};
export class CatalogPublicationError extends Error {
  declare public readonly cause: unknown;
  public constructor(
    cause: unknown,
    public readonly outcomes: readonly CatalogPublicationOutcome[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    this.name = 'CatalogPublicationError';
  }
}
interface PublicationScope {
  active: boolean;
  root: string;
  outcomes: CatalogPublicationOutcome[];
}
const publication = new AsyncLocalStorage<PublicationScope>();
interface ScanScope {
  active: boolean;
  observation: CatalogObservation;
}
const scan = new AsyncLocalStorage<ScanScope>();
let tail: Promise<unknown> = Promise.resolve();
let onChange: () => void = () => undefined;

export function setPluginCatalogChangeListener(listener: () => void): void {
  onChange = listener;
}

export function observePluginCatalog(): CatalogObservation {
  const root = resolve(getDataDir());
  return { root, generation: generations.get(root) ?? 0 };
}

export function isPluginCatalogObservationCurrent(
  observation: CatalogObservation,
): boolean {
  const current = observePluginCatalog();
  return (
    current.root === observation.root &&
    current.generation === observation.generation
  );
}

export function assertPluginCatalogObservation(
  observation: CatalogObservation,
): void {
  if (!isPluginCatalogObservationCurrent(observation)) {
    throw new Error(
      'Plugin catalog changed during discovery. Retry with a fresh scan.',
    );
  }
}

/** Discovery may intentionally deregister a rejected provider; never replay that effect to rescan. */
export async function withPluginCatalogScan<T>(
  work: () => Promise<T>,
): Promise<{ value: T; observation: CatalogObservation }> {
  const scope: ScanScope = {
    active: true,
    observation: observePluginCatalog(),
  };
  try {
    const value = await scan.run(scope, work);
    return { value, observation: scope.observation };
  } finally {
    scope.active = false;
  }
}

function advanceGeneration(root: string): void {
  generations.set(root, (generations.get(root) ?? 0) + 1);
}

/** Provider/payload attempts can change visible state even when they throw. */
export function notePluginCatalogEffects(): void {
  const currentScan = scan.getStore();
  const followsOwnEffect =
    currentScan?.active &&
    isPluginCatalogObservationCurrent(currentScan.observation);
  advanceGeneration(resolve(getDataDir()));
  // Only an uninterrupted observation may follow its own effect. A foreign
  // publication/invalidation stays stale even if another owned effect follows.
  if (currentScan && followsOwnEffect)
    currentScan.observation = observePluginCatalog();
  onChange();
}

export function assertPluginCatalogAdmission(): void {
  for (const namespace of ['plugins_cache', 'plugin_cache_index'] as const) {
    assertAdmittedWriter(namespace, 'electron_main', MODULE, STORAGE_OWNERSHIP);
  }
}

export function assertPluginPayloadAdmission(): void {
  assertAdmittedWriter(
    'plugin_cache',
    'electron_main',
    'main/plugins/plugin-service',
    STORAGE_OWNERSHIP,
  );
  assertPluginCatalogAdmission();
}

export function assertPluginCatalogHealth(allowLegacy = false): void {
  const root = getDataDir();
  const catalog = readPluginCatalog(join(root, 'plugins-cache.json'));
  const index = readPluginCacheIndex(join(root, 'plugin-cache-index.json'));
  for (const result of [catalog, index]) {
    if (result.state === 'valid' || result.state === 'absent') continue;
    if (allowLegacy && result === catalog && result.state === 'legacy')
      continue;
    throw new Error(
      `Couldn't use the plugin catalog because it is ${result.state}. Plugin changes and execution are blocked.`,
    );
  }
}

/** One slot includes validation, both documents when requested, and their settled notification. */
export function updatePluginCatalog<T>(work: () => Promise<T> | T): Promise<T> {
  const parent = publication.getStore();
  if (parent?.active) return Promise.resolve().then(work);
  const result = tail.then(async () => {
    const scope: PublicationScope = {
      active: true,
      root: resolve(getDataDir()),
      outcomes: [],
    };
    try {
      return await publication.run(scope, work);
    } catch (error) {
      throw new CatalogPublicationError(error, [...scope.outcomes]);
    } finally {
      scope.active = false;
      if (scope.outcomes.some((outcome) => outcome.state !== 'not_installed'))
        onChange();
    }
  });
  tail = result.catch(() => undefined);
  return result;
}

export function normalizePluginCatalog(
  cache: PluginsCache,
  advanceProviderStamp = false,
): PluginsCache {
  const previous = readPluginCatalog(join(getDataDir(), 'plugins-cache.json'));
  const latest = previous.state === 'valid' ? previous.data : undefined;
  const outgoing = decodePluginCatalog({
    ...latest,
    ...cache,
    lastProviderRefreshAt: advanceProviderStamp
      ? cache.lastProviderRefreshAt
      : latest?.lastProviderRefreshAt,
  });
  if (outgoing.state !== 'valid')
    throw new Error(
      "Couldn't save the plugin catalog because the updated data doesn't match the supported format. The existing file hasn't changed.",
    );
  const serializable: unknown = JSON.parse(JSON.stringify(outgoing.data));
  const committed = decodePluginCatalog(serializable);
  if (committed.state !== 'valid')
    throw new Error('Normalized plugin catalog is not serializable.');
  return committed.data;
}

export function normalizePluginCacheIndex(
  index: PluginCacheIndex,
): PluginCacheIndex {
  const serializable: unknown = JSON.parse(JSON.stringify(index));
  const outgoing = decodePluginCacheIndex(serializable);
  if (outgoing.state !== 'valid')
    throw new Error(
      "Couldn't save the plugin cache index because the updated data doesn't match the supported format. The existing file hasn't changed.",
    );
  return outgoing.data;
}

async function installDocument(
  document: CatalogPublicationOutcome['document'],
  data: PluginsCache | PluginCacheIndex,
  observation: CatalogObservation,
  allowLegacy: boolean,
): Promise<void> {
  const scope = publication.getStore();
  if (!scope?.active)
    throw new Error('Plugin publication requires an active store slot.');
  const root = resolve(getDataDir());
  const check = (): Promise<void> => {
    assertPluginCatalogAdmission();
    assertPluginCatalogHealth(allowLegacy);
    assertPluginCatalogObservation(observation);
    if (scope.root !== observation.root || root !== scope.root)
      throw new Error('Plugin catalog root changed.');
    return Promise.resolve();
  };
  try {
    await check();
    await createDirectoryDurably(root, { dataRoot: root });
    const admittedWriter: AdmittedWriterTarget = {
      namespace: document,
      writer: 'electron_main',
      module: MODULE,
    };
    const options = {
      encoding: 'utf-8' as const,
      durable: true,
      admittedWriter,
      beforeInstall: check,
    };
    const bytes = JSON.stringify(data, null, 2);
    if (document === 'plugins_cache') {
      // eslint-disable-next-line admitted-writers/no-unadmitted-write -- Only replaces metadata JSON, never plugin_cache payloads; remove when namespace matching distinguishes plugin-cache from plugin-cache-index.json.
      await writeFileAtomically(
        join(root, 'plugins-cache.json'),
        bytes,
        options,
      );
    } else {
      // eslint-disable-next-line admitted-writers/no-unadmitted-write -- Only replaces metadata JSON, never plugin_cache payloads; remove when namespace matching distinguishes plugin-cache from plugin-cache-index.json.
      await writeFileAtomically(
        join(root, 'plugin-cache-index.json'),
        bytes,
        options,
      );
    }
    scope.outcomes.push({
      document,
      state: 'durable',
      committed: structuredClone(data),
    });
    advanceGeneration(scope.root);
  } catch (error) {
    const installed = error instanceof StorageOutcomeUnknownError;
    scope.outcomes.push({
      document,
      state: installed ? 'installed_uncertain' : 'not_installed',
      ...(installed ? { installedCandidate: structuredClone(data) } : {}),
    });
    if (installed) advanceGeneration(scope.root);
    throw error;
  }
}

export function publishPluginCatalog(
  cache: PluginsCache,
  options?: {
    allowLegacy?: boolean;
    advanceProviderStamp?: boolean;
    observation?: CatalogObservation;
  },
): Promise<PluginsCache> {
  const observation = options?.observation ?? observePluginCatalog();
  return updatePluginCatalog(async () => {
    const outgoing = normalizePluginCatalog(
      cache,
      options?.advanceProviderStamp,
    );
    await installDocument(
      'plugins_cache',
      outgoing,
      observation,
      options?.allowLegacy === true,
    );
    return outgoing;
  });
}

/** Validate both first. A failed or uncertain first install never attempts the second. */
export function publishPluginCachePair(
  index: PluginCacheIndex,
  cache?: PluginsCache,
  observation = observePluginCatalog(),
): Promise<{
  index: PluginCacheIndex;
  catalog?: PluginsCache;
  outcomes: readonly CatalogPublicationOutcome[];
}> {
  return updatePluginCatalog(async () => {
    const normalizedIndex = normalizePluginCacheIndex(index);
    const catalog = cache ? normalizePluginCatalog(cache) : undefined;
    await installDocument(
      'plugin_cache_index',
      normalizedIndex,
      observation,
      false,
    );
    // Accept our index publication, not an intervening invalidation while its
    // directory flush was in flight.
    const afterIndex = {
      root: observation.root,
      generation: observation.generation + 1,
    };
    if (catalog)
      await installDocument('plugins_cache', catalog, afterIndex, false);
    return {
      index: normalizedIndex,
      ...(catalog ? { catalog } : {}),
      outcomes: [...(publication.getStore()?.outcomes ?? [])],
    };
  });
}
