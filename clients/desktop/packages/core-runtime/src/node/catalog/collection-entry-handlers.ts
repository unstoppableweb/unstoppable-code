import {
  CATALOG_COLLECTION_ERROR_CODES,
  CATALOG_COLLECTION_OPERATION_CODES,
  CatalogCollectionDeleteResultSchema,
  CatalogCollectionUpsertResultSchema,
  collectionEntryId,
  isBoundedCanopyJsonValue,
  type CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS,
  type CORE_CATALOG_COLLECTION_QUERY_DEFINITIONS,
  type CanopyErrorKind,
  type CanopyOperationCode,
  type CanopyRetryDirective,
  type CatalogCollectionEntry,
  type CatalogCollectionMembers,
  type CatalogSelectionRefs,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherHandlerMap,
  CanopyDispatcherInstructionHandlerMap,
} from '../../runtime/types';
import { CORE_CATALOG_ENTRY_RESOURCE } from './handlers';
import type { CatalogMutationRuns } from './mutation-runs';

/** A stored local collection as the host reads it; core adds the unresolved members. */
export type StoredCollectionEntry = Omit<
  CatalogCollectionEntry,
  'unresolvedMembers'
>;

export type CollectionEntryRead =
  | { status: 'found'; entry: StoredCollectionEntry }
  | { status: 'missing' }
  | { status: 'unreadable' };

export type CollectionEntryWrite =
  | { status: 'written'; entry: StoredCollectionEntry }
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'conflict'; currentRevision: string }
  | { status: 'ambiguousMembers' }
  | { status: 'tooLarge' };

export type CollectionEntryRemoval =
  | { status: 'deleted' }
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'conflict'; currentRevision: string };

/**
 * What a delete needs (`read: "management"`): the revision of any stored
 * collection, or the hash of the stored bytes of one that cannot be read.
 * `unreadable` when even its bytes cannot be read.
 */
export type CollectionEntryManagement =
  | { status: 'found'; revision: string }
  | { status: 'corrupt'; storedBytesHash: string }
  | { status: 'missing' }
  | { status: 'unreadable' };

/** `changed` when the stored bytes changed and still cannot be read. */
export type CollectionEntryCorruptRemoval =
  | CollectionEntryRemoval
  | { status: 'changed' };

export interface CollectionEntryDraft {
  name: string;
  description: string;
  members: CatalogCollectionMembers;
}

/** The local collection store behind `core.catalog.entry.*` (CAN-4170 PR 3b). */
export interface CoreCollectionEntryHost {
  /** A config that exists but can't be read is `unreadable`, never `missing`. */
  read(id: string): Promise<CollectionEntryRead>;
  create(draft: CollectionEntryDraft): Promise<StoredCollectionEntry>;
  /**
   * Replaces at `expectedRevision`, keeping provenance and the share link;
   * `ambiguousMembers` when the edit changes MCP members the store can't tell
   * apart, and `tooLarge` when the entry it would write fails `fits`, so it
   * writes nothing.
   */
  replace(
    id: string,
    expectedRevision: string,
    draft: CollectionEntryDraft,
    fits?: (entry: StoredCollectionEntry) => boolean,
  ): Promise<CollectionEntryWrite>;
  /** Deletes only at `expectedRevision`; its members, shares and selections stay. */
  delete(id: string, expectedRevision: string): Promise<CollectionEntryRemoval>;
  /** The store's local management read, as delete makes it (CAN-4170 PR 3b-2a). */
  readManagement(id: string): Promise<CollectionEntryManagement>;
  /**
   * Deletes a collection that cannot be read, only while its stored bytes
   * still have `storedBytesHash`; `conflict` once it can be read again.
   */
  deleteCorrupt(
    id: string,
    storedBytesHash: string,
  ): Promise<CollectionEntryCorruptRemoval>;
}

type LocalInstructionDefinitions = Omit<
  typeof CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS,
  'core.catalog.entry.import'
>;

export interface CoreCollectionEntryHandlers {
  queries: CanopyDispatcherHandlerMap<
    typeof CORE_CATALOG_COLLECTION_QUERY_DEFINITIONS
  >;
  instructions: CanopyDispatcherInstructionHandlerMap<LocalInstructionDefinitions>;
}

const codes = CATALOG_COLLECTION_ERROR_CODES;
const NEVER: CanopyRetryDirective = { kind: 'never' };
const REFRESH: CanopyRetryDirective = {
  kind: 'after_refresh',
  resource: CORE_CATALOG_ENTRY_RESOURCE,
};

function fail(
  kind: CanopyErrorKind,
  message: string,
  options: {
    code?: CanopyOperationCode;
    retry?: CanopyRetryDirective;
    currentRevision?: string;
  } = {},
): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    message,
    retry: options.retry ?? NEVER,
    ...(options.code !== undefined ? { code: options.code } : {}),
    ...(options.currentRevision !== undefined
      ? { details: { currentRevision: options.currentRevision } }
      : {}),
  });
}

const notFound = (): CanopyOperationError =>
  fail('not_found', 'This collection does not exist.', {
    code: codes.entryNotFound,
  });
const unreadable = (): CanopyOperationError =>
  fail('failed_precondition', "This collection's stored copy can't be read.", {
    code: codes.entryUnreadable,
  });
const notYet = (what: string): CanopyOperationError =>
  fail('capability_unavailable', `${what} isn't served through core yet.`);
const tooLarge = (): CanopyOperationError =>
  fail('resource_exhausted', 'This collection is too large to record.');
const keyReused = (): CanopyOperationError =>
  fail('conflict', 'This idempotency key was used with other parameters.');

/**
 * CAN-5898: whether the ledger can record this entry's answer with every
 * member unresolved, so a write is never made that its replay can't answer.
 */
function answerFits(entry: StoredCollectionEntry): boolean {
  return isBoundedCanopyJsonValue({
    entry: {
      ...entry,
      unresolvedMembers: unresolvedMembers(entry.members, {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      }),
    },
  });
}

/**
 * Whether a create's answer fits, with its revision, provenance and share at
 * their widest. A replace is checked on the entry it would write, under the
 * store's lock, since it keeps the stored provenance and share as they are.
 */
function recordable(draft: CollectionEntryDraft): boolean {
  const widest = 'w'.repeat(256);
  const stamp = '2026-01-01T00:00:00.000+00:00';
  return answerFits({
    kind: 'collection',
    entryId: collectionEntryId('f'.repeat(128)),
    revision: widest,
    name: draft.name,
    description: draft.description,
    members: draft.members,
    createdAt: stamp,
    updatedAt: stamp,
    sharedSource: {
      remoteId: widest.slice(0, 128),
      contentHash: widest.slice(0, 128),
      fromPublicShare: false,
      fetchedAt: stamp,
    },
    share: {
      remoteId: widest.slice(0, 128),
      contentHash: widest.slice(0, 128),
      shareScope: 'organization',
      sharedAt: stamp,
      accountId: 'w'.repeat(512),
    },
  });
}

const storeIdOf = (entryId: string): string =>
  entryId.slice(collectionEntryId('').length);

/** The members no installed skill, plugin or MCP server answers, in member order. */
function unresolvedMembers(
  members: CatalogCollectionMembers,
  installed: CatalogSelectionRefs,
): CatalogCollectionEntry['unresolvedMembers'] {
  const skills = new Set(
    installed.skillRefs.map((ref) => `${ref.sourceId}\u0000${ref.skillName}`),
  );
  const plugins = new Set(
    installed.pluginRefs.map(
      (ref) => `${ref.marketplaceId}\u0000${ref.pluginName}`,
    ),
  );
  const servers = new Set(
    installed.mcpServerRefs.map(
      (ref) => `${ref.serverId}\u0000${ref.configId}`,
    ),
  );
  return [
    ...members.skills
      .filter((ref) => !skills.has(`${ref.sourceId}\u0000${ref.skillName}`))
      .map((ref) => ({ kind: 'skill' as const, ...ref })),
    ...members.plugins
      .filter(
        (ref) => !plugins.has(`${ref.marketplaceId}\u0000${ref.pluginName}`),
      )
      .map((ref) => ({ kind: 'plugin' as const, ...ref })),
    ...members.mcpServers
      .filter((ref) => !servers.has(`${ref.serverId}\u0000${ref.configId}`))
      .map((ref) => ({ kind: 'mcp_server' as const, ...ref })),
  ];
}

/**
 * `core.catalog.entry.get`, `upsert` and `delete` for local collections
 * (CAN-4170 PR 3b-1). Shared updates, import readiness and import arrive in
 * PRs 4 and 5; each answers `capability_unavailable` until then.
 */
export function createCoreCollectionEntryHandlers(options: {
  host: CoreCollectionEntryHost;
  runs: CatalogMutationRuns;
  /** The installed skills, plugins and MCP servers members resolve against. */
  installed: () => Promise<CatalogSelectionRefs>;
}): CoreCollectionEntryHandlers {
  const { host, runs } = options;

  const readInstalled = async (): Promise<CatalogSelectionRefs> => {
    try {
      return await options.installed();
    } catch {
      throw fail(
        'unavailable',
        'The installed catalog cannot be read right now.',
        {
          retry: { kind: 'same_request' },
        },
      );
    }
  };

  const withUnresolved = (
    stored: StoredCollectionEntry,
    installed: CatalogSelectionRefs,
  ): CatalogCollectionEntry => ({
    ...stored,
    unresolvedMembers: unresolvedMembers(stored.members, installed),
  });

  const conflict = (currentRevision: string): CanopyOperationError =>
    fail('conflict', 'This collection changed since it was read.', {
      code: codes.revisionConflict,
      retry: REFRESH,
      currentRevision,
    });

  const written = (
    write: CollectionEntryWrite,
    installed: CatalogSelectionRefs,
  ): { entry: CatalogCollectionEntry } => {
    if (write.status === 'tooLarge') throw tooLarge();
    if (write.status === 'missing') throw notFound();
    if (write.status === 'unreadable') throw unreadable();
    if (write.status === 'conflict') throw conflict(write.currentRevision);
    if (write.status === 'ambiguousMembers')
      throw fail(
        'failed_precondition',
        "This edit changes MCP server connections that can't be told apart here. Edit the collection in the app.",
      );
    return { entry: withUnresolved(write.entry, installed) };
  };

  return {
    queries: {
      'core.catalog.entry.get': async (params) => {
        if (params.read === 'importReadiness')
          throw notYet('Import readiness for a shared collection');
        if (params.read === 'management') {
          const management = await host.readManagement(
            storeIdOf(params.entryId),
          );
          if (management.status === 'missing') throw notFound();
          if (management.status === 'unreadable') throw unreadable();
          return management.status === 'found'
            ? {
                read: 'management',
                entryId: params.entryId,
                revision: management.revision,
              }
            : {
                read: 'management',
                entryId: params.entryId,
                storedBytesHash: management.storedBytesHash,
              };
        }
        const read = await host.read(storeIdOf(params.entryId));
        if (read.status === 'missing') throw notFound();
        if (read.status === 'unreadable') throw unreadable();
        return {
          read: 'entry',
          entry: withUnresolved(read.entry, await readInstalled()),
        };
      },
    },
    instructions: {
      'core.catalog.entry.upsert': async (params, context) => {
        if (params.sharedRevision !== null)
          throw notYet('Applying a shared collection revision');
        const draft: CollectionEntryDraft = {
          name: params.name.trim(),
          description: params.description,
          members: params.members,
        };
        // Only a new key meets the size bound: a recorded key replays (the
        // bound may have narrowed since), and a reused one is refused as such.
        // A replace meets it in the store, on the entry it would write.
        const fresh =
          (await runs.receiptState({
            kind: 'core.catalog.entry.upsert',
            context,
            params,
          })) === 'none';
        if (fresh && params.entryId === null && !recordable(draft))
          throw tooLarge();
        // A new key reads the installed catalog before admission, so a failed
        // read refuses with nothing written and stays retryable under its key.
        const installedFirst = fresh ? await readInstalled() : null;
        return runs.run({
          kind: 'core.catalog.entry.upsert',
          context,
          params,
          codes: CATALOG_COLLECTION_OPERATION_CODES.upsert,
          keyReused,
          decode: (outcome) =>
            CatalogCollectionUpsertResultSchema.safeParse(outcome).data ?? null,
          effect: async () => {
            const installed = installedFirst ?? (await readInstalled());
            return params.entryId === null
              ? { entry: withUnresolved(await host.create(draft), installed) }
              : written(
                  await host.replace(
                    storeIdOf(params.entryId),
                    params.expectedRevision,
                    draft,
                    answerFits,
                  ),
                  installed,
                );
          },
        });
      },
      'core.catalog.entry.delete': (params, context) =>
        runs.run({
          kind: 'core.catalog.entry.delete',
          context,
          params,
          codes: CATALOG_COLLECTION_OPERATION_CODES.delete,
          keyReused,
          decode: (outcome) =>
            CatalogCollectionDeleteResultSchema.safeParse(outcome).data ?? null,
          effect: async () => {
            const id = storeIdOf(params.entryId);
            const removal =
              'expectedStoredBytesHash' in params
                ? await host.deleteCorrupt(id, params.expectedStoredBytesHash)
                : await host.delete(id, params.expectedRevision);
            if (removal.status === 'missing') throw notFound();
            if (removal.status === 'unreadable') throw unreadable();
            if (removal.status === 'conflict')
              throw conflict(removal.currentRevision);
            if (removal.status === 'changed')
              throw fail(
                'conflict',
                'This collection changed since it was read.',
                {
                  code: codes.revisionConflict,
                  retry: REFRESH,
                },
              );
            return {
              kind: 'collection' as const,
              entryId: params.entryId,
              deleted: true as const,
            };
          },
        }),
    },
  };
}
