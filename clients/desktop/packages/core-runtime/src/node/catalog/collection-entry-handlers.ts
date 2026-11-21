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
  | { status: 'ambiguousMembers' };

export type CollectionEntryRemoval =
  | { status: 'deleted' }
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'conflict'; currentRevision: string };

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
   * apart, so it writes nothing.
   */
  replace(
    id: string,
    expectedRevision: string,
    draft: CollectionEntryDraft,
  ): Promise<CollectionEntryWrite>;
  /** Deletes only at `expectedRevision`; its members, shares and selections stay. */
  delete(id: string, expectedRevision: string): Promise<CollectionEntryRemoval>;
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
const keyReused = (): CanopyOperationError =>
  fail('conflict', 'This idempotency key was used with other parameters.');

/**
 * CAN-5898: whether the ledger can record the largest result this upsert could
 * answer, with every member unresolved and provenance and share at their
 * widest, so a write is never made that its replay can't answer.
 */
function recordable(draft: CollectionEntryDraft): boolean {
  const widest = 'w'.repeat(256);
  const stamp = '2026-01-01T00:00:00.000+00:00';
  const worst: CatalogCollectionEntry = {
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
    },
    unresolvedMembers: unresolvedMembers(draft.members, {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    }),
  };
  return isBoundedCanopyJsonValue({ entry: worst });
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
        if (!recordable(draft))
          throw fail(
            'resource_exhausted',
            'This collection is too large to record.',
          );
        // A new key reads the installed catalog before admission, so a failed
        // read refuses with nothing written and stays retryable under its key.
        const recorded = await runs.recordedOperationId({
          kind: 'core.catalog.entry.upsert',
          context,
          params,
        });
        const installedFirst = recorded === null ? await readInstalled() : null;
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
            const removal = await host.delete(
              storeIdOf(params.entryId),
              params.expectedRevision,
            );
            if (removal.status === 'missing') throw notFound();
            if (removal.status === 'unreadable') throw unreadable();
            if (removal.status === 'conflict')
              throw conflict(removal.currentRevision);
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
