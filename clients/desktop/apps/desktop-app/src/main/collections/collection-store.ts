import { parseCollectionIndexSharedSource } from '@canopy/protocol/collections';
import {
  normalizeInstalledAt,
  parseInstalledAt,
} from '@canopy/protocol/installed-items';
import {
  resourceContextEnabled,
  resourceContextSnapshot,
  assertResourceContextSnapshot,
} from '../lib/resource-context';
import {
  assertInstalledResourceContext,
  assertLocalCollectionManagementContext,
  recordResourceInstall,
} from '../lib/resource-install-context';
import { getSharedCollection } from './canopy-server-client';
import {
  recordSharedItemInstall,
  recordSharedItemUninstall,
} from '../canopy-cloud/shared-item-subscriptions';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { writeFileAtomically } from '../lib/atomic-file';
import { dirname } from 'node:path';
import type {
  CollectionConfig,
  CollectionConfigFile,
  CollectionIndexEntry,
  CollectionIndexFile,
} from '@canopy/desktop-shared/types/collections';
import type {
  BundleConfig,
  BundleConfigFile,
  BundlesIndexFile,
} from '@canopy/desktop-shared/types/bundles';
import {
  getBundleConfigFilePath,
  getBundlesIndexFilePath,
  getCollectionConfigFilePath,
  getCollectionsDir,
  getCollectionsIndexFilePath,
} from '../lib/paths';
import { isErrnoException } from '../lib/type-guards';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { classifyInstalledResourceOrigin } from '../lib/resource-install-context';
import {
  parseShareRemoteMetadata,
  type ShareRemoteMetadata,
} from '@canopy/protocol/sharing';

// All index repairs and writers share this boundary. Call unlocked helpers only
// while holding it; network/import work should capture a revision and finalize
// through a guarded save rather than retaining the lock across installation.
let collectionStoreTail: Promise<unknown> = Promise.resolve();
const mutationContext = new AsyncLocalStorage<{
  snapshot?: string;
  active: boolean;
}>();

async function assertMutationContext(): Promise<void> {
  const snapshot = mutationContext.getStore()?.snapshot;
  if (snapshot !== undefined) await assertResourceContextSnapshot(snapshot);
}

async function withCollectionStoreLock<T>(work: () => Promise<T>): Promise<T> {
  if (mutationContext.getStore()?.active) return work();
  const snapshot = resourceContextEnabled()
    ? await resourceContextSnapshot()
    : undefined;
  const result = collectionStoreTail.then(() =>
    mutationContext.run({ snapshot, active: true }, async () => {
      const lease = mutationContext.getStore();
      try {
        await assertMutationContext();
        return await work();
      } finally {
        if (lease) lease.active = false;
      }
    }),
  );
  collectionStoreTail = result.catch(() => undefined);
  return result;
}

function notifyCollectionInventoryChanged(): void {
  // Subscribers must queue their own reads/repairs, not inherit this writer lease.
  mutationContext.exit(() => notifyDesktopInventoryChanged(['collections']));
}

export interface CollectionSaveGuard {
  /** Required for a guarded replacement; a missing row is never recreated. */
  expectedRevision: string | undefined;
  /** Revalidate the originating Portal session/project immediately before writes. */
  assertCurrent?: () => Promise<void>;
  /** Check the complete stored response before any persistence effects. */
  validatePrepared?: (collection: CollectionConfig) => void;
}

export class CollectionMutationError extends Error {
  constructor(
    readonly code: 'conflict' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

const SAFE_ID_RE = /^[a-f0-9-]+$/;

function toIndexEntry(
  collection: CollectionConfig,
  includeCreatedAt = false,
): CollectionIndexEntry {
  // Only mutations persist this optional field. Existing index repairs and
  // migrations triggered by reads are not installation-date backfills.
  const createdAt = includeCreatedAt
    ? normalizeInstalledAt(collection.createdAt)
    : undefined;
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    ...(createdAt ? { createdAt } : {}),
    updatedAt: collection.updatedAt,
    ...(collection.revision ? { revision: collection.revision } : {}),
    skillCount: new Set(
      collection.skills.map((ref) =>
        JSON.stringify([ref.sourceId, ref.skillName]),
      ),
    ).size,
    pluginCount: new Set(
      collection.plugins.map((ref) =>
        JSON.stringify([ref.marketplaceId, ref.pluginName.toLowerCase()]),
      ),
    ).size,
    mcpServerCount: new Set(
      collection.mcpServers.map((ref) =>
        JSON.stringify([ref.serverId, ref.configId]),
      ),
    ).size,
    hasExistingShare: Boolean(collection.remote),
    ...(collection.remote ? { remote: collection.remote } : {}),
    ...(collection.sharedSource !== undefined ? { hasSharedSource: true } : {}),
    ...(parseCollectionIndexSharedSource(collection.sharedSource)
      ? {
          sharedSource: parseCollectionIndexSharedSource(
            collection.sharedSource,
          ),
        }
      : {}),
  };
}

/**
 * A row re-projected from its config by a read keeps the date the index
 * already stores for it (CAN-5239); it never gains one from the config.
 */
function withStoredCreatedAt(
  row: CollectionIndexEntry,
  stored: CollectionIndexEntry,
): CollectionIndexEntry {
  return stored.createdAt === undefined
    ? row
    : { ...row, createdAt: stored.createdAt };
}

// Stored files are unvalidated. The web rejects the whole Collections list for
// one row that fails isCollectionRow
// (apps/web/src/lib/desktop-inventory/inventory-result-parsers.ts:412-428, its
// only row check; an invalid sharedSource is dropped, not rejected). The web
// app can't be imported here, so this mirrors every clause of it.
function isValidRevision(revision: unknown): boolean {
  return (
    revision === undefined ||
    (typeof revision === 'string' &&
      revision.trim().length > 0 &&
      revision.length <= 256)
  );
}

function isListableRow(row: CollectionIndexEntry): boolean {
  const fields: Record<string, unknown> = { ...row };
  return (
    ['id', 'name', 'description', 'updatedAt'].every(
      (key) => typeof fields[key] === 'string',
    ) &&
    ['skillCount', 'pluginCount', 'mcpServerCount'].every(
      (key) => typeof fields[key] === 'number',
    ) &&
    isValidRevision(fields.revision)
  );
}

function fromLegacyBundle(bundle: BundleConfig): CollectionConfig {
  const fields: Record<string, unknown> = { ...bundle };
  return {
    id: bundle.id,
    name: bundle.name,
    description:
      typeof fields.description === 'string' ? fields.description : '',
    skills: Array.isArray(bundle.skills) ? bundle.skills : [],
    plugins: Array.isArray(bundle.plugins) ? bundle.plugins : [],
    mcpServers: Array.isArray(bundle.mcpServers) ? bundle.mcpServers : [],
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
  };
}

type CollectionIndexRead =
  | { status: 'ok'; index: CollectionIndexFile }
  | { status: 'missing' }
  | { status: 'damaged' | 'newer'; raw: string };

/** Absence, damage and a newer version stay distinct; a read error throws. */
async function readCollectionIndexFile(): Promise<CollectionIndexRead> {
  let raw: string;
  try {
    raw = await readFile(getCollectionsIndexFilePath(), 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { status: 'missing' };
    }
    throw new Error(
      `Unreadable collections/index.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: CollectionIndexFile;
  try {
    parsed = JSON.parse(raw) as CollectionIndexFile;
  } catch {
    return { status: 'damaged', raw };
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof parsed.version === 'number' &&
    parsed.version > 2
  ) {
    return { status: 'newer', raw };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    parsed.version !== 2 ||
    !Array.isArray(parsed.collections)
  ) {
    return { status: 'damaged', raw };
  }
  return {
    status: 'ok',
    index: {
      ...parsed,
      collections: parsed.collections.map((entry) => {
        const { sharedSource: raw, remote: rawRemote, ...rest } = entry;
        const sharedSource = parseCollectionIndexSharedSource(raw);
        const remote = parseShareRemoteMetadata(rawRemote);
        return {
          ...rest,
          ...(remote ? { remote } : {}),
          ...(raw !== undefined || entry.hasSharedSource
            ? { hasSharedSource: true }
            : {}),
          ...(sharedSource ? { sharedSource } : {}),
        };
      }),
    },
  };
}

async function readLegacyBundleIndexFile(): Promise<BundlesIndexFile | null> {
  try {
    const raw = await readFile(getBundlesIndexFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as BundlesIndexFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.bundles)) {
      return { version: 1, bundles: [] };
    }
    return parsed;
  } catch (error) {
    // An I/O failure must not publish an index that ends the conversion.
    if (isErrnoException(error)) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return { version: 1, bundles: [] };
  }
}

async function readLegacyBundleConfig(
  id: string,
): Promise<CollectionConfig | null> {
  try {
    if (!SAFE_ID_RE.test(id)) throw new Error(`Invalid bundle id ${id}`);
    const raw = await readFile(getBundleConfigFilePath(id), 'utf8');
    const parsed = JSON.parse(raw) as BundleConfigFile;
    if (parsed.version !== 1 || parsed.bundle?.id !== id) {
      throw new Error(`Invalid bundle config for ${id}`);
    }
    const collection = fromLegacyBundle(parsed.bundle);
    if (!isListableRow(toIndexEntry(collection))) {
      throw new Error(`Bundle config for ${id} has no listable row`);
    }
    return collection;
  } catch (error) {
    // An I/O failure retries the conversion on the next read; content that
    // cannot convert is skipped for good, and the file stays on disk.
    if (isErrnoException(error) && error.code !== 'ENOENT') throw error;
    process.emitWarning(
      `Skipping malformed legacy bundle config ${id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function writeCollectionIndexFile(
  collections: CollectionIndexEntry[],
  complete = true,
): Promise<void> {
  const filePath = getCollectionsIndexFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const payload: CollectionIndexFile = {
    version: 2,
    ...(complete
      ? {
          entrySchema: 2 as const,
          memberCountsSchema: 1 as const,
          authorLinkSchema: 1 as const,
        }
      : {}),
    collections,
  };
  await assertMutationContext();
  await writeFileAtomically(filePath, JSON.stringify(payload, null, 2), {
    durable: true,
  });
  // The index is what the portal (and the cloud inventory sync) projects.
  notifyCollectionInventoryChanged();
}

async function writeCollectionConfigFile(
  collection: CollectionConfig,
  assertCurrent?: () => Promise<void>,
  onWriteStarted?: () => void,
): Promise<CollectionConfigFile> {
  const filePath = getCollectionConfigFilePath(collection.id);
  await mkdir(dirname(filePath), { recursive: true });
  const payload: CollectionConfigFile = { version: 2, collection };
  await assertCurrent?.();
  await assertMutationContext();
  onWriteStarted?.();
  await writeFileAtomically(filePath, JSON.stringify(payload, null, 2), {
    durable: true,
  });
  return payload;
}

async function migrateLegacyBundles(): Promise<CollectionIndexFile> {
  const legacyIndex = await readLegacyBundleIndexFile();
  if (!legacyIndex) {
    return { version: 2, collections: [] };
  }

  const collections: CollectionConfig[] = [];
  for (const entry of legacyIndex.bundles) {
    const collection = await readLegacyBundleConfig(entry.id);
    if (collection) {
      collections.push(collection);
      await writeCollectionConfigFile(collection);
    }
  }

  const indexFile: CollectionIndexFile = {
    version: 2,
    collections: collections.map((collection) => toIndexEntry(collection)),
  };
  await writeCollectionIndexFile(indexFile.collections);
  return indexFile;
}

/**
 * Re-project every entry from its config once, for indexes written before
 * entries carried `sharedSource`, canonical member counts or `remote`. An unreadable config keeps its entry, and a
 * failed write only defers the repair to the next read.
 */
async function repairIndexEntrySchema(
  currentIndex: CollectionIndexFile,
): Promise<CollectionIndexFile> {
  let complete = true;
  const collections = await Promise.all(
    currentIndex.collections.map(async (entry) => {
      try {
        const file = await readCollectionConfigUnfiltered(entry.id, false);
        if (file)
          return withStoredCreatedAt(toIndexEntry(file.collection), entry);
      } catch {
        // Keep the stored entry; the config stays readable through its own path.
      }
      complete = false;
      return {
        ...entry,
        provenanceUnknown: true,
        hasExistingShare:
          typeof entry.hasExistingShare === 'boolean'
            ? entry.hasExistingShare
            : false,
      };
    }),
  );
  try {
    if (complete) await writeCollectionIndexFile(collections);
  } catch (error) {
    process.emitWarning(
      `Could not save the repaired collections/index.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    version: 2,
    ...(complete
      ? {
          entrySchema: 2 as const,
          memberCountsSchema: 1 as const,
          authorLinkSchema: 1 as const,
        }
      : {}),
    collections,
  };
}

/** True once every entry was projected by the current {@link toIndexEntry}. */
function indexSchemaComplete(index: CollectionIndexFile): boolean {
  return (
    index.entrySchema === 2 &&
    index.memberCountsSchema === 1 &&
    index.authorLinkSchema === 1
  );
}

const COLLECTION_CONFIG_FILE_RE = /^collection-([a-f0-9-]+)\.json$/;

/**
 * Bring the index in line with the configs, the authoritative records: drop rows
 * whose config is gone, re-project rows an interrupted edit left stale and list
 * configs an interrupted save never indexed. Unreadable configs keep their row
 * and stay on disk unlisted otherwise.
 */
async function reconcileIndexWithConfigs(
  index: CollectionIndexFile,
  mustWrite: boolean,
): Promise<CollectionIndexFile> {
  let fileNames: string[] = [];
  try {
    fileNames = await readdir(getCollectionsDir());
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  const unindexed = new Set(
    fileNames.flatMap((name) => {
      const id = COLLECTION_CONFIG_FILE_RE.exec(name)?.[1];
      return id ? [id] : [];
    }),
  );
  // A config whose content cannot be read or projected, whose stored id is not
  // its file name's, or whose stored revision or row fails the web's row check
  // is unreadable. An I/O error instead leaves reconcile to retry next read.
  let retry = false;
  const project = async (
    id: string,
  ): Promise<{ createdAt: string; row: CollectionIndexEntry } | null> => {
    try {
      const file = await readCollectionConfigUnfiltered(id, false);
      if (file?.collection.id !== id) return null;
      // The row drops a falsy revision, so check the stored one too.
      if (!isValidRevision(file.collection.revision)) return null;
      // CAN-5239: a rebuilt row stays undated; a backfill is a follow-up.
      const row = toIndexEntry(file.collection);
      return isListableRow(row)
        ? { createdAt: String(file.collection.createdAt), row }
        : null;
    } catch (error) {
      if (isErrnoException(error)) retry = true;
      return null;
    }
  };
  // Read every config at once to keep the store lock held briefly.
  const projections = new Map(
    await Promise.all(
      [...unindexed].map(async (id) => [id, await project(id)] as const),
    ),
  );
  // Listing reads fail until a reconcile reads every config, so callers such
  // as inventory sync keep their last good list.
  if (mustWrite || !retry) rebuildIncomplete = retry;
  let changed = mustWrite;
  const collections: CollectionIndexEntry[] = [];
  for (const entry of index.collections) {
    if (!unindexed.delete(entry.id)) {
      changed = true;
      continue;
    }
    const projected = projections.get(entry.id);
    if (projected && projected.row.revision !== entry.revision) {
      collections.push(withStoredCreatedAt(projected.row, entry));
      changed = true;
    } else {
      collections.push(entry);
    }
  }
  const adopted: Array<{ createdAt: string; row: CollectionIndexEntry }> = [];
  for (const id of unindexed) {
    const projected = projections.get(id);
    if (projected) adopted.push(projected);
  }
  adopted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  collections.push(...adopted.map(({ row }) => row));
  if (!changed && adopted.length === 0) {
    indexReconciled = !retry;
    return index;
  }
  const complete = mustWrite || indexSchemaComplete(index);
  try {
    await writeCollectionIndexFile(collections, complete);
    indexReconciled = !retry;
  } catch (error) {
    // A set-aside index must be replaced before it is reported as recovered;
    // otherwise the next read retries the reconcile.
    if (mustWrite) throw error;
    process.emitWarning(
      `Could not save the reconciled collections/index.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // A rebuild that could not read every config is written, so the damaged
  // index is copied aside once, but it is not reported as recovered.
  if (mustWrite && retry) {
    throw new Error(
      'Some Collection configs could not be read; the next read finishes rebuilding collections/index.json.',
    );
  }
  return {
    version: 2,
    ...(complete
      ? {
          entrySchema: 2 as const,
          memberCountsSchema: 1 as const,
          authorLinkSchema: 1 as const,
        }
      : {}),
    collections,
  };
}

/** Keep a damaged or newer index as evidence; nothing is written if the copy fails. */
async function setIndexAside(status: 'damaged' | 'newer'): Promise<void> {
  const path = getCollectionsIndexFilePath();
  await assertMutationContext();
  await copyFile(
    path,
    `${path}.${status}-${Date.now()}`,
    constants.COPYFILE_EXCL,
  );
}

// Lazily, once per process: set once a reconcile's result is on disk.
let indexReconciled = false;
// Set while a rebuilt index still lacks configs an I/O error left unread.
let rebuildIncomplete = false;

/** The index for listing; saves still use the partial index while a rebuild is incomplete. */
async function readListedCollectionIndex(): Promise<CollectionIndexFile> {
  const index = await withCollectionStoreLock(readCollectionIndexUnfiltered);
  if (rebuildIncomplete) {
    throw new Error(
      'Some Collection configs could not be read; collections/index.json is still being rebuilt.',
    );
  }
  // CAN-5239: an invalid stored date is unknown; the row itself is kept.
  return {
    ...index,
    collections: index.collections.map((entry) => {
      if (entry.createdAt === undefined) return entry;
      const createdAt = normalizeInstalledAt(entry.createdAt);
      if (createdAt === entry.createdAt) return entry;
      const next: CollectionIndexEntry = { ...entry };
      delete next.createdAt;
      return createdAt ? { ...next, createdAt } : next;
    }),
  };
}

async function readCollectionIndexUnfiltered(): Promise<CollectionIndexFile> {
  const read = await readCollectionIndexFile();
  if (read.status === 'damaged' || read.status === 'newer') {
    await setIndexAside(read.status);
    return reconcileIndexWithConfigs({ version: 2, collections: [] }, true);
  }
  const index =
    read.status === 'ok'
      ? await readStoredCollectionIndex(read.index)
      : await migrateLegacyBundles();
  if (indexReconciled) return index;
  return reconcileIndexWithConfigs(index, false);
}

async function readStoredCollectionIndex(
  currentIndex: CollectionIndexFile,
): Promise<CollectionIndexFile> {
  if (!indexSchemaComplete(currentIndex)) {
    return repairIndexEntrySchema(currentIndex);
  }
  const hasLegacyEntries = currentIndex.collections.some(
    (entry) => typeof entry.hasExistingShare !== 'boolean',
  );
  if (!hasLegacyEntries) return currentIndex;

  const collections = await Promise.all(
    currentIndex.collections.map(async (entry) => {
      if (typeof entry.hasExistingShare === 'boolean') return entry;
      const file = await readCollectionConfigUnfiltered(entry.id, false);
      return {
        ...entry,
        hasExistingShare: Boolean(file?.collection.remote),
      };
    }),
  );
  await writeCollectionIndexFile(collections);
  return { ...currentIndex, collections };
}

async function readCollectionConfigUnfiltered(
  id: string,
  recoverLegacy = true,
): Promise<CollectionConfigFile | null> {
  if (!id || !SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid Collection id: ${id}`);
  }

  try {
    const raw = await readFile(getCollectionConfigFilePath(id), 'utf8');
    const parsed = JSON.parse(raw) as CollectionConfigFile;
    if (parsed.version !== 2 || !parsed.collection) {
      throw new Error(`Invalid Collection config for ${id}`);
    }
    const remote = parseShareRemoteMetadata(parsed.collection.remote);
    return {
      version: 2,
      collection: {
        ...parsed.collection,
        revision:
          parsed.collection.revision ??
          createHash('sha256').update(raw).digest('hex'),
        mcpServers: Array.isArray(parsed.collection.mcpServers)
          ? parsed.collection.mcpServers
          : [],
        ...(remote ? { remote } : {}),
      },
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      if (!recoverLegacy) return null;
      await readCollectionIndexUnfiltered();
      return readCollectionConfigUnfiltered(id, false);
    }
    throw error;
  }
}

/** Atomic config reads stay parallel; only missing-file legacy recovery can write. */
async function readCollectionConfigWithRecovery(
  id: string,
): Promise<CollectionConfigFile | null> {
  const file = await readCollectionConfigUnfiltered(id, false);
  return (
    file ?? withCollectionStoreLock(() => readCollectionConfigUnfiltered(id))
  );
}

/** Inventory for the background policy resolver, including legacy migration.
 * The caller must authorize both the collection origin and its members before use.
 */
export async function readCollectionConfigForBackgroundAuthorization(
  id: string,
): Promise<CollectionConfigFile | null> {
  return readCollectionConfigWithRecovery(id);
}

async function authorizeCollectionSource(
  id: string,
  source: NonNullable<CollectionConfig['sharedSource']>,
  verifyHash = false,
): Promise<void> {
  if (source.fromPublicShare) {
    const { getPublicCollectionShareSnapshot } =
      await import('../canopy-cloud/public-share-client');
    const snapshot = await getPublicCollectionShareSnapshot(source.remoteId);
    if (
      verifyHash &&
      source.contentHash &&
      snapshot.contentHash !== source.contentHash
    ) {
      throw new Error('The shared collection changed. Open the link again.');
    }
    await recordResourceInstall(
      'collections',
      {
        id: snapshot.externalId,
        contentHash: snapshot.contentHash,
        owner: { shareScope: 'private' },
        shareScope: 'private',
      },
      [id],
      'public-share',
    );
  } else {
    const detail = await getSharedCollection(source.remoteId);
    if (
      verifyHash &&
      source.contentHash &&
      detail.contentHash !== source.contentHash
    )
      throw new Error('The shared collection changed. Open it again.');
    await recordResourceInstall('collections', detail, [id]);
  }
}

type CollectionSharedSource = NonNullable<CollectionConfig['sharedSource']>;

function collectionSubscriptionSourceKind(
  source: CollectionSharedSource,
): 'shared' | 'public' {
  return source.fromPublicShare === true ? 'public' : 'shared';
}

function unregisterCollectionInstall(
  id: string,
  source: CollectionSharedSource | undefined,
): void {
  if (!source) return;
  recordSharedItemUninstall({
    kind: 'collection',
    remoteId: source.remoteId,
    sourceKind: collectionSubscriptionSourceKind(source),
    localId: id,
  });
}

/**
 * Every Collection installed from a share, across all contexts, for the
 * one-time install subscription backfill. Reads provenance only.
 */
export async function listCollectionSharedSourcesForBackfill(): Promise<
  Array<{ id: string; sharedSource: CollectionSharedSource }>
> {
  const index = await withCollectionStoreLock(readCollectionIndexUnfiltered);
  const installs: Array<{ id: string; sharedSource: CollectionSharedSource }> =
    [];
  for (const entry of index.collections) {
    // One unreadable Collection must not hide the others.
    const sharedSource = await readCollectionConfigWithRecovery(entry.id).then(
      (file) => file?.collection.sharedSource,
      () => undefined,
    );
    if (sharedSource) installs.push({ id: entry.id, sharedSource });
  }
  return installs;
}

export async function readCollectionConfig(
  id: string,
): Promise<CollectionConfigFile | null> {
  if (!resourceContextEnabled()) return readCollectionConfigWithRecovery(id);
  const snapshot = await resourceContextSnapshot();
  await assertInstalledResourceContext('collections', id, getSharedCollection);
  const file = await readCollectionConfigWithRecovery(id);
  if (file?.collection.sharedSource) {
    await authorizeCollectionSource(id, file.collection.sharedSource);
  }
  await assertResourceContextSnapshot(snapshot);
  return file;
}

/** Complete local snapshot for editing, duplication and removal; no network fetch. */
export async function readLocalCollectionSnapshot(
  id: string,
): Promise<CollectionConfigFile | null> {
  const snapshot = resourceContextEnabled()
    ? await resourceContextSnapshot()
    : undefined;
  await assertLocalCollectionManagementContext(id);
  const file = await readCollectionConfigWithRecovery(id);
  // A source without a receipt cannot silently become local ownership when
  // context enforcement is active. Live authorization repairs its receipt.
  if (resourceContextEnabled() && file?.collection.sharedSource) {
    const origin = await classifyInstalledResourceOrigin('collections', id);
    if (origin === 'local')
      await authorizeCollectionSource(id, file.collection.sharedSource);
  }
  if (snapshot !== undefined) await assertResourceContextSnapshot(snapshot);
  return file;
}

export async function readCollectionIndex(): Promise<CollectionIndexFile> {
  const index = await readListedCollectionIndex();
  if (!resourceContextEnabled()) return index;
  const snapshot = await resourceContextSnapshot();
  const allowed = await Promise.all(
    index.collections.map(async (entry): Promise<boolean> => {
      try {
        return (await readLocalCollectionSnapshot(entry.id)) !== null;
      } catch {
        return false;
      }
    }),
  );
  await assertResourceContextSnapshot(snapshot);
  return {
    ...index,
    collections: index.collections.filter((_entry, i) => allowed[i]),
  };
}

/** Read one Collection through the context-independent Personal sync view. */
export async function readPersonalCollectionConfig(
  id: string,
): Promise<CollectionConfigFile | null> {
  const file = await readCollectionConfigWithRecovery(id);
  if (!file) return null;
  const origin = await classifyInstalledResourceOrigin('collections', id);
  if (origin === 'excluded') return null;
  if (
    resourceContextEnabled() &&
    origin === 'local' &&
    file.collection.sharedSource
  ) {
    return null;
  }
  return file;
}

/** Read the Collection index through the Personal sync view. */
export async function readPersonalCollectionIndex(): Promise<CollectionIndexFile> {
  const index = await readListedCollectionIndex();
  const allowed = await Promise.all(
    index.collections.map(
      async (entry) => (await readPersonalCollectionConfig(entry.id)) !== null,
    ),
  );
  return {
    ...index,
    collections: index.collections.filter((_entry, index) => allowed[index]),
  };
}

async function saveCollectionConfigUnlocked(
  input: Partial<CollectionConfig> & { name: string },
  onPrepared?: (collection: CollectionConfig) => void,
  guard?: CollectionSaveGuard,
): Promise<CollectionConfig> {
  // Complete desktop snapshots also carry their read revision. Legacy callers
  // that omit it retain their compatibility API; new editors must echo it.
  const mutationGuard: CollectionSaveGuard | undefined =
    guard ??
    (input.id && input.revision
      ? { expectedRevision: input.revision }
      : undefined);
  const now = new Date().toISOString();
  const id = input.id || randomUUID();
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid Collection id: ${id}`);
  }
  if (!input.name || !input.name.trim()) {
    throw new Error('Collection name is required');
  }
  const existing = input.id
    ? await readCollectionConfigUnfiltered(input.id)
    : null;

  if (mutationGuard && input.id) {
    if (!existing)
      throw new CollectionMutationError('not_found', 'Collection not found.');
    if (
      !mutationGuard.expectedRevision ||
      existing.collection.revision !== mutationGuard.expectedRevision
    )
      throw new CollectionMutationError(
        'conflict',
        'Collection changed. Reload it before saving.',
      );
  }
  const remote = input.remote ?? existing?.collection.remote;
  const sharedSource = input.sharedSource ?? existing?.collection.sharedSource;
  // CAN-5239: set once, on the copy's first save. A re-save keeps a stored
  // valid date; an unknown one (missing, null, not a date) stays absent, so no
  // value the core contract rejects is written. A caller's date never wins.
  const storedCreatedAt = existing?.collection.createdAt;
  const createdAt = existing
    ? typeof storedCreatedAt === 'string' &&
      parseInstalledAt(storedCreatedAt) !== undefined
      ? storedCreatedAt
      : undefined
    : now;
  const collection: CollectionConfig = {
    revision: randomUUID(),
    id,
    name: input.name.trim(),
    description: input.description ?? '',
    skills: Array.isArray(input.skills) ? input.skills : [],
    plugins: Array.isArray(input.plugins) ? input.plugins : [],
    mcpServers: Array.isArray(input.mcpServers) ? input.mcpServers : [],
    ...(createdAt === undefined ? {} : { createdAt }),
    updatedAt: now,
    ...(remote ? { remote } : {}),
    ...(sharedSource ? { sharedSource } : {}),
  };

  for (const skill of collection.skills) {
    if (
      typeof skill.sourceId !== 'string' ||
      typeof skill.skillName !== 'string'
    ) {
      throw new Error('Invalid skill reference in Collection');
    }
  }
  for (const plugin of collection.plugins) {
    if (
      typeof plugin.marketplaceId !== 'string' ||
      typeof plugin.pluginName !== 'string'
    ) {
      throw new Error('Invalid plugin reference in Collection');
    }
  }
  for (const mcpServer of collection.mcpServers) {
    if (
      typeof mcpServer.serverId !== 'string' ||
      typeof mcpServer.configId !== 'string' ||
      !SAFE_ID_RE.test(mcpServer.serverId) ||
      !SAFE_ID_RE.test(mcpServer.configId)
    ) {
      throw new Error('Invalid MCP server reference in Collection');
    }
  }

  mutationGuard?.validatePrepared?.(collection);
  onPrepared?.(collection);
  if (resourceContextEnabled()) {
    const snapshot = await resourceContextSnapshot();
    if (input.id) await readCollectionConfig(input.id);
    else
      await assertInstalledResourceContext(
        'collections',
        id,
        getSharedCollection,
      );
    if (sharedSource) {
      await authorizeCollectionSource(id, sharedSource, !existing);
    }
    await assertResourceContextSnapshot(snapshot);
  }

  const index = await readCollectionIndexUnfiltered();
  await mutationGuard?.assertCurrent?.();
  await assertMutationContext();
  // Preserve stable index order, including multiple copies of the same source.
  const nextEntries = index.collections.map((entry) =>
    entry.id === id ? toIndexEntry(collection, true) : entry,
  );
  if (!nextEntries.some((entry) => entry.id === id))
    nextEntries.push(toIndexEntry(collection, true));
  let writeStarted = false;
  try {
    await writeCollectionConfigFile(
      collection,
      mutationGuard?.assertCurrent,
      () => {
        writeStarted = true;
      },
    );
    await writeCollectionIndexFile(
      nextEntries,
      indexSchemaComplete(index) || index.collections.length === 0,
    );
  } catch (error) {
    // A durable write can reject after rename (directory sync). Restore both
    // files under the writer lock even when the failure came from config save.
    // A guard rejection before IO must not cause a compensating write.
    if (writeStarted) {
      if (existing) {
        await writeFileAtomically(
          getCollectionConfigFilePath(id),
          JSON.stringify(existing, null, 2),
          { durable: true },
        );
      } else {
        try {
          await unlink(getCollectionConfigFilePath(id));
        } catch (cleanupError) {
          if (!isErrnoException(cleanupError) || cleanupError.code !== 'ENOENT')
            throw cleanupError;
        }
      }
      await writeFileAtomically(
        getCollectionsIndexFilePath(),
        JSON.stringify(index, null, 2),
        { durable: true },
      );
      notifyCollectionInventoryChanged();
    }
    throw error;
  }

  // Only an install or update names its source; a local edit carries it over.
  if (input.sharedSource) {
    recordSharedItemInstall({
      kind: 'collection',
      remoteId: input.sharedSource.remoteId,
      sourceKind: collectionSubscriptionSourceKind(input.sharedSource),
      contentHash: input.sharedSource.contentHash ?? null,
      localId: id,
    });
  }

  return collection;
}

/** Persist the author-side cloud link beside a local Collection. */
async function writeCollectionRemoteMetadataUnlocked(
  id: string,
  remote: ShareRemoteMetadata,
): Promise<boolean> {
  const file = await readCollectionConfigUnfiltered(id);
  if (!file) return false;
  const collection = {
    ...file.collection,
    remote: { ...remote },
    revision: randomUUID(),
  };
  const index = await readCollectionIndexUnfiltered();
  let writeStarted = false;
  try {
    await writeCollectionConfigFile(collection, undefined, () => {
      writeStarted = true;
    });
    await writeCollectionIndexFile(
      index.collections.map((entry) =>
        entry.id === id ? toIndexEntry(collection, true) : entry,
      ),
      indexSchemaComplete(index),
    );
  } catch (error) {
    if (writeStarted) {
      await writeFileAtomically(
        getCollectionConfigFilePath(id),
        JSON.stringify(file, null, 2),
        { durable: true },
      );
      await writeFileAtomically(
        getCollectionsIndexFilePath(),
        JSON.stringify(index, null, 2),
        { durable: true },
      );
      notifyCollectionInventoryChanged();
    }
    throw error;
  }
  return true;
}

/** Clear every local Collection linked to the deleted cloud share. */
async function clearCollectionRemoteMetadataByRemoteIdUnlocked(
  remoteId: string,
): Promise<number> {
  const index = await readCollectionIndexUnfiltered();
  const nextEntries = [...index.collections];
  const changedCollections: CollectionConfig[] = [];
  let count = 0;
  try {
    for (
      let entryIndex = 0;
      entryIndex < index.collections.length;
      entryIndex += 1
    ) {
      const entry = index.collections[entryIndex];
      if (!entry) continue;
      // The cloud share is already gone; one unreadable config must not keep
      // the others linked to it.
      const file = await readCollectionConfigUnfiltered(entry.id).catch(
        () => null,
      );
      if (file?.collection.remote?.remoteId !== remoteId) continue;
      const collection = { ...file.collection };
      delete collection.remote;
      collection.revision = randomUUID();
      await writeCollectionConfigFile(collection, undefined, () => {
        changedCollections.push(file.collection);
      });
      nextEntries[entryIndex] = toIndexEntry(collection, true);
      count += 1;
    }
    if (count > 0)
      await writeCollectionIndexFile(nextEntries, indexSchemaComplete(index));
  } catch (error) {
    for (const collection of changedCollections) {
      await writeFileAtomically(
        getCollectionConfigFilePath(collection.id),
        JSON.stringify({ version: 2, collection }, null, 2),
        { durable: true },
      );
    }
    if (changedCollections.length > 0) {
      await writeFileAtomically(
        getCollectionsIndexFilePath(),
        JSON.stringify(index, null, 2),
        { durable: true },
      );
      notifyCollectionInventoryChanged();
    }
    throw error;
  }
  return count;
}

async function deleteCollectionConfigUnlocked(id: string): Promise<void> {
  if (!id || !SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid Collection id: ${id}`);
  }

  if (resourceContextEnabled()) await readLocalCollectionSnapshot(id);
  // Read before the file goes: it is the only record of the install source.
  // An unreadable file never blocks the delete.
  const sharedSource = await readCollectionConfigUnfiltered(id, false).then(
    (file) => file?.collection.sharedSource,
    () => undefined,
  );

  // An unreadable index refuses the delete before the config goes.
  const index = await readCollectionIndexUnfiltered();
  await assertMutationContext();
  try {
    await unlink(getCollectionConfigFilePath(id));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }

  await writeCollectionIndexFile(
    index.collections.filter((entry) => entry.id !== id),
    indexSchemaComplete(index),
  );
  unregisterCollectionInstall(id, sharedSource);
}

/** Only a main-owned aborted install may remove its exact local write. No cloud grant is needed. */
async function rollbackNewCollectionInstallUnlocked(
  expected: CollectionConfig,
  initial?: CollectionConfig,
): Promise<void> {
  const assertOwnWrite = async (): Promise<void> => {
    const file = await readCollectionConfigUnfiltered(expected.id);
    if (
      file &&
      JSON.stringify(file.collection) !== JSON.stringify(expected) &&
      (!initial ||
        initial.id !== expected.id ||
        JSON.stringify(file.collection) !== JSON.stringify(initial))
    ) {
      throw new Error(
        'Collection changed during installation; cleanup was not applied.',
      );
    }
  };
  await assertOwnWrite();
  const { createResourceInstallReceiptsStore } =
    await import('../lib/resource-install-receipts');
  const binding = await createResourceInstallReceiptsStore(
    'collection-install-rollback',
  ).findLocal('collections', expected.id);
  if (binding) {
    await createResourceInstallReceiptsStore(binding.accountId).rollbackInstall(
      { ...binding.receipt, localResourceIds: [expected.id] },
      undefined,
    );
  }
  // The collection is already indexed, so an edit can land during the awaits
  // above. Check again right before removing the file; a foreground read
  // restores the receipt alias of a collection that is kept.
  await assertOwnWrite();
  try {
    await unlink(getCollectionConfigFilePath(expected.id));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  const index = await readCollectionIndexUnfiltered();
  await writeCollectionIndexFile(
    index.collections.filter((entry) => entry.id !== expected.id),
    indexSchemaComplete(index),
  );
  unregisterCollectionInstall(expected.id, expected.sharedSource);
}

export function saveCollectionConfig(
  input: Partial<CollectionConfig> & { name: string },
  onPrepared?: (collection: CollectionConfig) => void,
  guard?: CollectionSaveGuard,
): Promise<CollectionConfig> {
  return withCollectionStoreLock(() =>
    saveCollectionConfigUnlocked(input, onPrepared, guard),
  );
}

export function writeCollectionRemoteMetadata(
  id: string,
  remote: ShareRemoteMetadata,
): Promise<boolean> {
  return withCollectionStoreLock(() =>
    writeCollectionRemoteMetadataUnlocked(id, remote),
  );
}

export function clearCollectionRemoteMetadataByRemoteId(
  remoteId: string,
): Promise<number> {
  return withCollectionStoreLock(() =>
    clearCollectionRemoteMetadataByRemoteIdUnlocked(remoteId),
  );
}

export function deleteCollectionConfig(
  id: string,
  guard?: Pick<CollectionSaveGuard, 'expectedRevision'>,
): Promise<void> {
  if (guard)
    return withCollectionStoreLock(async () => {
      const existing = await readCollectionConfigUnfiltered(id);
      if (!existing)
        throw new CollectionMutationError('not_found', 'Collection not found.');
      if (
        !guard.expectedRevision ||
        existing.collection.revision !== guard.expectedRevision
      )
        throw new CollectionMutationError(
          'conflict',
          'Collection changed. Reload it before deleting.',
        );
      return deleteCollectionConfigUnlocked(id);
    });
  return withCollectionStoreLock(() => deleteCollectionConfigUnlocked(id));
}

export function rollbackNewCollectionInstall(
  expected: CollectionConfig,
  initial?: CollectionConfig,
): Promise<void> {
  return withCollectionStoreLock(() =>
    rollbackNewCollectionInstallUnlocked(expected, initial),
  );
}
