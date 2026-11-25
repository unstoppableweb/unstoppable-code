import type {
  CollectionEntryCorruptRemoval,
  CollectionEntryDraft,
  CollectionEntryManagement,
  CollectionEntryRead,
  CollectionEntryRemoval,
  CollectionEntryWrite,
  CoreCollectionEntryHost,
  StoredCollectionEntry,
} from '@canopy/core-runtime/node/catalog';
import {
  CatalogCollectionEntrySchema,
  CatalogCollectionRevisionSchema,
  collectionEntryId,
} from '@canopy/protocol/canopy-core';
import {
  COLLECTION_SHARE_SCOPES,
  type CollectionShareScope,
} from '@canopy/protocol/collections';
import type {
  CollectionConfig,
  CollectionMcpRef,
} from '@canopy/desktop-shared/types/collections';
import type {
  CollectionSaveGuard,
  CollectionStoredBytesState,
} from '../collections/collection-store';

/** The collection store calls the host makes; tests inject fakes. */
export interface DesktopCollectionEntryStore {
  /** Null when the store has no such collection; throws when it can't read one. */
  read(id: string): Promise<CollectionConfig | null>;
  /** The store's local management read, as its own delete makes it. */
  readLocal(id: string): Promise<CollectionConfig | null>;
  save(
    input: Partial<CollectionConfig> & { name: string },
    guard?: CollectionSaveGuard,
  ): Promise<CollectionConfig>;
  delete(
    id: string,
    guard: Pick<CollectionSaveGuard, 'expectedRevision'>,
  ): Promise<void>;
  /** The store's own refusal of a save or delete, if `error` is one. */
  refusalOf(error: unknown): 'conflict' | 'not_found' | null;
  /** Whether a config can be read, and its bytes hash when it can't. */
  storedBytesState(id: string): Promise<CollectionStoredBytesState>;
  deleteCorrupt(
    id: string,
    storedBytesHash: string,
  ): Promise<
    'deleted' | 'missing' | 'readable' | 'unreadable' | 'changed' | 'refused'
  >;
}

type RevisedCollection = CollectionConfig & { revision: string };

/** A replace's prepared entry failed the caller's `fits`, before any write. */
class EntryTooLargeError extends Error {}

const isRevised = (
  collection: CollectionConfig,
): collection is RevisedCollection =>
  CatalogCollectionRevisionSchema.safeParse(collection.revision).success;

const defaultStore: DesktopCollectionEntryStore = {
  read: async (id) =>
    (
      await (
        await import('../collections/collection-store')
      ).readCollectionConfig(id)
    )?.collection ?? null,
  readLocal: async (id) =>
    (
      await (
        await import('../collections/collection-store')
      ).readLocalCollectionSnapshot(id)
    )?.collection ?? null,
  save: async (input, guard) =>
    (await import('../collections/collection-store')).saveCollectionConfig(
      input,
      undefined,
      guard,
    ),
  delete: async (id, guard) =>
    (await import('../collections/collection-store')).deleteCollectionConfig(
      id,
      guard,
    ),
  refusalOf: (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'conflict' || error.code === 'not_found')
      ? error.code
      : null,
  storedBytesState: async (id) =>
    (
      await import('../collections/collection-store')
    ).readCollectionStoredBytesState(id),
  deleteCorrupt: async (id, storedBytesHash) =>
    (
      await import('../collections/collection-store')
    ).deleteCorruptCollectionConfig(id, storedBytesHash),
};

const isShareScope = (value: string): value is CollectionShareScope =>
  COLLECTION_SHARE_SCOPES.some((scope) => scope === value);

function storedEntry(collection: RevisedCollection): StoredCollectionEntry {
  const { sharedSource, remote } = collection;
  return {
    kind: 'collection',
    entryId: collectionEntryId(collection.id),
    revision: collection.revision,
    name: collection.name,
    description: collection.description,
    members: {
      skills: collection.skills.map(({ sourceId, skillName }) => ({
        sourceId,
        skillName,
      })),
      plugins: collection.plugins.map(({ marketplaceId, pluginName }) => ({
        marketplaceId,
        pluginName,
      })),
      mcpServers: collection.mcpServers.map(({ serverId, configId }) => ({
        serverId,
        configId,
      })),
    },
    ...(collection.createdAt === undefined
      ? {}
      : { createdAt: collection.createdAt }),
    updatedAt: collection.updatedAt,
    sharedSource: sharedSource
      ? {
          remoteId: sharedSource.remoteId,
          contentHash: sharedSource.contentHash ?? null,
          fromPublicShare: sharedSource.fromPublicShare ?? false,
          fetchedAt: sharedSource.fetchedAt,
        }
      : null,
    share:
      remote && isShareScope(remote.shareScope)
        ? {
            remoteId: remote.remoteId,
            contentHash: remote.contentHash,
            shareScope: remote.shareScope,
            sharedAt: remote.sharedAt,
            ...(remote.accountId === undefined
              ? {}
              : { accountId: remote.accountId }),
          }
        : null,
  };
}

/** The stored entry, or null when the contract can't carry it. */
function projected(
  collection: RevisedCollection,
): StoredCollectionEntry | null {
  try {
    const entry = storedEntry(collection);
    return CatalogCollectionEntrySchema.safeParse({
      ...entry,
      unresolvedMembers: [],
    }).success
      ? entry
      : null;
  } catch {
    return null;
  }
}

/**
 * The contract's MCP member has no `owner` (an organization's connection), so
 * a replace maps each member onto a stored ref with the same ids, in stored
 * order, and keeps that ref whole. Null when an edit changes how many members
 * share ids with an organization's ref: which ref it means, or whose a new
 * one is, can't be known.
 */
function withStoredOwners(
  members: CollectionEntryDraft['members']['mcpServers'],
  stored: readonly CollectionMcpRef[],
): CollectionMcpRef[] | null {
  const idsOf = (ref: { serverId: string; configId: string }): string =>
    `${ref.serverId}\u0000${ref.configId}`;
  const storedByIds = new Map<string, CollectionMcpRef[]>();
  for (const ref of stored)
    storedByIds.set(idsOf(ref), [...(storedByIds.get(idsOf(ref)) ?? []), ref]);
  const counts = new Map<string, number>();
  for (const member of members)
    counts.set(idsOf(member), (counts.get(idsOf(member)) ?? 0) + 1);
  for (const [ids, refs] of storedByIds) {
    const count = counts.get(ids) ?? 0;
    if (count === 0 || count === refs.length) continue;
    if (refs.some((ref) => ref.owner !== undefined)) return null;
  }
  return members.map(
    (member) =>
      storedByIds.get(idsOf(member))?.shift() ?? {
        serverId: member.serverId,
        configId: member.configId,
      },
  );
}

/** `core.catalog.entry.*` over Electron main's collection store (CAN-4170 PR 3b). */
export function createDesktopCollectionEntryHost(
  store: DesktopCollectionEntryStore = defaultStore,
): CoreCollectionEntryHost {
  // The store always sets a revision; a config without one can't be compared.
  const readRevised = async (
    id: string,
    local: boolean,
  ): Promise<RevisedCollection | null | 'unreadable'> => {
    let collection: CollectionConfig | null;
    try {
      collection = local ? await store.readLocal(id) : await store.read(id);
    } catch {
      return 'unreadable';
    }
    if (collection === null) return null;
    return isRevised(collection) ? collection : 'unreadable';
  };
  // One whose projection the contract refuses can't be answered or replaced.
  const read = async (
    id: string,
  ): Promise<
    | { collection: RevisedCollection; entry: StoredCollectionEntry }
    | null
    | 'unreadable'
  > => {
    const collection = await readRevised(id, false);
    if (collection === null || collection === 'unreadable') return collection;
    const entry = projected(collection);
    return entry === null ? 'unreadable' : { collection, entry };
  };
  const written = (collection: CollectionConfig): StoredCollectionEntry => {
    if (!isRevised(collection))
      throw new Error('The collection store saved no revision.');
    return storedEntry(collection);
  };
  return {
    async read(id): Promise<CollectionEntryRead> {
      const stored = await read(id);
      if (stored === 'unreadable') return { status: 'unreadable' };
      if (stored === null) return { status: 'missing' };
      return { status: 'found', entry: stored.entry };
    },
    async create(draft) {
      return written(
        await store.save({
          name: draft.name,
          description: draft.description,
          skills: draft.members.skills,
          plugins: draft.members.plugins,
          mcpServers: draft.members.mcpServers,
        }),
      );
    },
    async replace(
      id,
      expectedRevision,
      draft,
      fits,
    ): Promise<CollectionEntryWrite> {
      const stored = await read(id);
      if (stored === 'unreadable') return { status: 'unreadable' };
      if (stored === null) return { status: 'missing' };
      const current = stored.collection;
      if (current.revision !== expectedRevision)
        return { status: 'conflict', currentRevision: current.revision };
      const mcpServers = withStoredOwners(
        draft.members.mcpServers,
        current.mcpServers,
      );
      if (mcpServers === null) return { status: 'ambiguousMembers' };
      try {
        const saved = await store.save(
          {
            id,
            name: draft.name,
            description: draft.description,
            skills: draft.members.skills,
            plugins: draft.members.plugins,
            mcpServers,
            createdAt: current.createdAt,
          },
          {
            expectedRevision,
            ...(fits
              ? {
                  validatePrepared: (prepared: CollectionConfig): void => {
                    if (!fits(written(prepared)))
                      throw new EntryTooLargeError();
                  },
                }
              : {}),
          },
        );
        return { status: 'written', entry: written(saved) };
      } catch (error) {
        if (error instanceof EntryTooLargeError) return { status: 'tooLarge' };
        const refusal = store.refusalOf(error);
        if (refusal === null) throw error;
        if (refusal === 'not_found') return { status: 'missing' };
        const latest = await read(id);
        if (latest === 'unreadable') return { status: 'unreadable' };
        if (latest === null) return { status: 'missing' };
        return {
          status: 'conflict',
          currentRevision: latest.collection.revision,
        };
      }
    },
    async delete(id, expectedRevision): Promise<CollectionEntryRemoval> {
      const current = await readRevised(id, true);
      if (current === 'unreadable') return { status: 'unreadable' };
      if (current === null) return { status: 'missing' };
      if (current.revision !== expectedRevision)
        return { status: 'conflict', currentRevision: current.revision };
      try {
        await store.delete(id, { expectedRevision });
        return { status: 'deleted' };
      } catch (error) {
        const refusal = store.refusalOf(error);
        if (refusal === null) throw error;
        if (refusal === 'not_found') return { status: 'missing' };
        const latest = await readRevised(id, true);
        if (latest === 'unreadable') return { status: 'unreadable' };
        if (latest === null) return { status: 'missing' };
        return { status: 'conflict', currentRevision: latest.revision };
      }
    },
    async readManagement(id): Promise<CollectionEntryManagement> {
      const current = await readRevised(id, true);
      if (current === null) return { status: 'missing' };
      if (current !== 'unreadable')
        return { status: 'found', revision: current.revision };
      let state: CollectionStoredBytesState;
      try {
        state = await store.storedBytesState(id);
      } catch {
        return { status: 'unreadable' };
      }
      if (state.status === 'missing') return { status: 'missing' };
      if (state.status === 'unreadable') return { status: 'unreadable' };
      if (state.status === 'corrupt')
        return { status: 'corrupt', storedBytesHash: state.storedBytesHash };
      // Repaired between the two reads: answer its revision once it reads.
      const repaired = await readRevised(id, true);
      if (repaired === null) return { status: 'missing' };
      return repaired === 'unreadable'
        ? { status: 'unreadable' }
        : { status: 'found', revision: repaired.revision };
    },
    async deleteCorrupt(
      id,
      storedBytesHash,
    ): Promise<CollectionEntryCorruptRemoval> {
      const outcome = await store.deleteCorrupt(id, storedBytesHash);
      if (outcome === 'deleted') return { status: 'deleted' };
      if (outcome === 'missing') return { status: 'missing' };
      if (outcome === 'changed') return { status: 'changed' };
      if (outcome === 'unreadable' || outcome === 'refused')
        return { status: 'unreadable' };
      const latest = await readRevised(id, true);
      if (latest === 'unreadable') return { status: 'unreadable' };
      if (latest === null) return { status: 'missing' };
      return { status: 'conflict', currentRevision: latest.revision };
    },
  };
}
