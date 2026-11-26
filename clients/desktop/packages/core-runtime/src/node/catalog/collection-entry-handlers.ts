import { randomUUID } from 'node:crypto';
import { MCP_SHARE_BLOCKED_MESSAGE } from '@canopy/protocol/collections';
import {
  PIPELINE_PACKAGE_MAX_INVOCATION_DISMISSALS,
  isDismissibleInvocationToken,
} from '@canopy/protocol/pipelines';
import {
  CATALOG_COLLECTION_ERROR_CODES,
  CATALOG_COLLECTION_OPERATION_CODES,
  CatalogCollectionDeleteResultSchema,
  CatalogCollectionImportResultSchema,
  CatalogCollectionUpsertResultSchema,
  collectionEntryId,
  isBoundedCanopyJsonValue,
  type CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS,
  type CORE_CATALOG_COLLECTION_QUERY_DEFINITIONS,
  type CanopyErrorKind,
  type CanopyOperationCode,
  type CanopyRetryDirective,
  type CatalogCollectionAnalysis,
  type CatalogCollectionEntry,
  type CatalogCollectionInvocationDismissal,
  type CatalogCollectionMembers,
  type CatalogCollectionShareDocument,
  type CatalogSelectionRefs,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  canopyCancelledError,
} from '../../runtime/errors';
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

/** What analyze packages, and the share document it is for (CAN-4170 PR 4a). */
export interface CollectionEntryAnalysisRequest {
  id: string;
  /** The stored members the document was checked against. */
  members: CatalogCollectionMembers;
  document: CatalogCollectionShareDocument;
  /** Left out, the saved dismissals apply; a list replaces them. */
  dismissedInvocations?: CatalogCollectionInvocationDismissal[];
}

/** A commit's upload of an analysis it made (CAN-4170 PR 4c). */
export interface CollectionEntryCommitRequest {
  analysisId: string;
  selectedOptionalResourceIds: string[];
  /** The account the analysis was made under; null when none was signed in. */
  accountId: string | null;
  /** The caller's abort; the upload stops before its next request. */
  signal: AbortSignal;
}

/** Why a host refused a commit; the handler answers each with its code. */
export type CollectionEntryCommitRefusal =
  | 'analysisNotFound'
  | 'packageBlocked'
  | 'packageStale'
  | 'remoteAccessDenied'
  | 'remoteUnavailable';

export type CollectionEntryCommit =
  | {
      status: 'committed';
      package: { version: 1; digest: string };
      uploadId: string;
    }
  | { status: 'refused'; refusal: CollectionEntryCommitRefusal };

/** Why a host couldn't read a shared collection's readiness (PR 4b-1). */
export type CollectionImportReadinessRefusal =
  | 'remoteNotFound'
  | 'remoteAccessDenied'
  | 'remoteUnavailable'
  | 'answerTooLarge';

export type CollectionImportReadinessRead =
  | {
      status: 'found';
      readiness: Extract<
        Awaited<
          ReturnType<
            CoreCollectionEntryHandlers['queries']['core.catalog.entry.get']
          >
        >,
        { read: 'importReadiness' }
      >['readiness'];
    }
  | { status: 'refused'; refusal: CollectionImportReadinessRefusal };

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
  /** Analyzes the members into a package for the document; nothing is uploaded. */
  analyze(
    request: CollectionEntryAnalysisRequest,
  ): Promise<CatalogCollectionAnalysis>;
  /** Drops an analysis, so nothing can commit it. */
  dropAnalysis(analysisId: string): Promise<void>;
  /** The signed-in cloud account's id, read locally; null when none (PR 4c). */
  signedInAccountId(): Promise<string | null>;
  /** Uploads a live analysis's package under one cloud account (PR 4c). */
  commit(request: CollectionEntryCommitRequest): Promise<CollectionEntryCommit>;
  /**
   * What installing a shared collection needs here (PR 4b-1); it writes
   * nothing but the MCP status read's stale-token eviction (CAN-7919).
   */
  readImportReadiness(
    remoteId: string,
    fromPublicShare: boolean,
    signal: AbortSignal,
  ): Promise<CollectionImportReadinessRead>;
}

type LocalInstructionDefinitions =
  typeof CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS;

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

/** The answer to each commit refusal (CAN-4170 PR 4c). */
const COMMIT_REFUSALS: Record<
  CollectionEntryCommitRefusal,
  () => CanopyOperationError
> = {
  analysisNotFound: () =>
    fail(
      'not_found',
      'This analysis expired or was never made for this collection. Analyze it again.',
      { code: codes.analysisNotFound },
    ),
  packageBlocked: () =>
    fail(
      'failed_precondition',
      "This collection's package can't be shared until its blockers are resolved.",
      { code: codes.packageBlocked },
    ),
  packageStale: () =>
    fail(
      'conflict',
      'This collection changed since it was analyzed. Analyze it again.',
      { code: codes.packageStale, retry: REFRESH },
    ),
  remoteAccessDenied: () =>
    fail('permission_denied', "The cloud account can't share this package.", {
      code: codes.remoteAccessDenied,
    }),
  // The run records this refusal under its key, so only a new request (and
  // key) reaches the cloud again.
  remoteUnavailable: () =>
    fail('unavailable', 'The cloud catalog cannot be reached right now.', {
      code: codes.remoteUnavailable,
    }),
};

/** The answer to each readiness refusal (CAN-4170 PR 4b-1). */
const READINESS_REFUSALS: Record<
  CollectionImportReadinessRefusal,
  () => CanopyOperationError
> = {
  remoteNotFound: () =>
    fail(
      'not_found',
      "This shared collection doesn't exist or isn't shared with you.",
      {
        code: codes.remoteNotFound,
      },
    ),
  remoteAccessDenied: () =>
    fail(
      'permission_denied',
      "The cloud account can't read this shared collection.",
      {
        code: codes.remoteAccessDenied,
      },
    ),
  remoteUnavailable: () =>
    fail('unavailable', 'The cloud catalog cannot be reached right now.', {
      code: codes.remoteUnavailable,
      retry: { kind: 'same_request' },
    }),
  answerTooLarge: () =>
    fail(
      'resource_exhausted',
      "This shared collection's requirements are too large to answer here.",
    ),
};

/** How many analyses commit remembers the collection and revision of. */
const ANALYSIS_BINDINGS = 16;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * CAN-4170 PR 4a: a collection with an MCP server member can't be shared,
 * so analyze answers it blocked before anything reads its connections.
 */
function mcpShareBlocked(
  members: CatalogCollectionMembers,
): CatalogCollectionAnalysis | null {
  if (members.mcpServers.length === 0) return null;
  return {
    analysisId: randomUUID(),
    state: 'blocked',
    blockers: [
      {
        code: 'MCP_SHARE_BLOCKED',
        subject: null,
        message: MCP_SHARE_BLOCKED_MESSAGE,
      },
    ],
    resources: [],
    requirements: [],
    unpackageableMemberLabels: [],
    dismissedInvocations: [],
    expiresAt: new Date().toISOString(),
  };
}

/**
 * CAN-4170 PR 4a: whether the dismissal store can save these, so a request it
 * would refuse mid-analysis is refused before the operation runs.
 */
function storableDismissals(
  dismissals: readonly CatalogCollectionInvocationDismissal[],
): boolean {
  const distinct = new Set(
    dismissals.map(({ provider, token }) => `${provider}\u0000${token}`),
  );
  return (
    distinct.size <= PIPELINE_PACKAGE_MAX_INVOCATION_DISMISSALS &&
    dismissals.every(({ token }) => isDismissibleInvocationToken(token))
  );
}

/** A document item's kind and name, or null for an item no member can be. */
function documentItemKey(item: unknown): string | null {
  if (!isRecord(item)) return null;
  if (
    (item.type === 'skill' || item.type === 'custom_skill') &&
    typeof item.skill_name === 'string'
  )
    return `skill\u0000${item.skill_name}`;
  if (
    (item.type === 'claude_plugin' || item.type === 'codex_plugin') &&
    typeof item.plugin_name === 'string'
  )
    return `plugin\u0000${item.plugin_name}`;
  return null;
}

/**
 * CAN-4170 PR 4a: whether the share document's items name exactly the stored
 * members, as a multiset of kind and name. Names are the strongest identity
 * both sides carry without a catalog read; a document's portable sources map
 * to local ones only through the installed catalog.
 */
function documentNamesMembers(
  document: CatalogCollectionShareDocument,
  members: CatalogCollectionMembers,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.rawCollection);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) return false;
  const named: string[] = [];
  for (const item of parsed.items) {
    const key = documentItemKey(item);
    if (key === null) return false;
    named.push(key);
  }
  const stored = [
    ...members.skills.map((ref) => `skill\u0000${ref.skillName}`),
    ...members.plugins.map((ref) => `plugin\u0000${ref.pluginName}`),
  ];
  named.sort();
  stored.sort();
  return (
    named.length === stored.length &&
    named.every((key, index) => key === stored[index])
  );
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
 * (CAN-4170 PR 3b-1), `get` `read: "importReadiness"` (PR 4b-1), and
 * `import` modes `analyze` (PR 4a) and `commit` (PR 4c). Shared updates and
 * install arrive in PRs 4 and 5; each answers `capability_unavailable` until
 * then.
 */
export function createCoreCollectionEntryHandlers(options: {
  host: CoreCollectionEntryHost;
  runs: CatalogMutationRuns;
  /** The installed skills, plugins and MCP servers members resolve against. */
  installed: () => Promise<CatalogSelectionRefs>;
}): CoreCollectionEntryHandlers {
  const { host, runs } = options;
  // One analysis of a collection at a time, from its read to its answer: the
  // analyzer keeps only the newest request's dismissals for a collection, and
  // a request that waited must read the revision it then analyzes.
  const analyzing = new Map<string, Promise<unknown>>();
  // The collection and revision each answered analysis was made over, so a
  // commit uploads only this collection's analysis of the revision it names.
  // shortcut: in memory like the analyses themselves, so a restart forgets
  // both; upgrade if analyses persist.
  const analyzedBy = new Map<
    string,
    {
      id: string;
      revision: string;
      blocked: boolean;
      expiresAt: number;
      accountId: string | null;
    }
  >();
  const pruneAnalyzed = (): void => {
    const now = Date.now();
    for (const [analysisId, made] of analyzedBy)
      if (made.expiresAt <= now) analyzedBy.delete(analysisId);
    for (const analysisId of [...analyzedBy.keys()].slice(
      0,
      Math.max(0, analyzedBy.size - ANALYSIS_BINDINGS),
    ))
      analyzedBy.delete(analysisId);
  };
  const inTurn = async <Result>(
    id: string,
    work: () => Promise<Result>,
  ): Promise<Result> => {
    const run = (analyzing.get(id) ?? Promise.resolve()).then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    analyzing.set(id, settled);
    try {
      return await run;
    } finally {
      if (analyzing.get(id) === settled) analyzing.delete(id);
    }
  };

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
      'core.catalog.entry.get': async (params, context) => {
        if (params.read === 'importReadiness') {
          const read = await host.readImportReadiness(
            params.remoteId,
            params.fromPublicShare,
            context.signal,
          );
          if (context.signal.aborted) throw canopyCancelledError();
          if (read.status === 'refused')
            throw READINESS_REFUSALS[read.refusal]();
          return { read: 'importReadiness', readiness: read.readiness };
        }
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
      'core.catalog.entry.import': (params, context) => {
        if (params.mode === 'commit')
          return runs.run({
            kind: 'core.catalog.entry.import',
            context,
            params,
            codes: CATALOG_COLLECTION_OPERATION_CODES.import,
            keyReused,
            decode: (outcome) =>
              CatalogCollectionImportResultSchema.safeParse(outcome).data ??
              null,
            effect: async () => {
              const id = storeIdOf(params.entryId);
              if (context.signal.aborted) throw canopyCancelledError();
              // The read authorizes as entry.get's does (which may read an installed
              // collection's hosted share), before any capability read or upload.
              const read = await host.read(id);
              if (context.signal.aborted) throw canopyCancelledError();
              if (read.status === 'missing') throw notFound();
              if (read.status === 'unreadable') throw unreadable();
              if (read.entry.revision !== params.expectedRevision)
                throw conflict(read.entry.revision);
              // A collection with an MCP server member can't be shared.
              if (read.entry.members.mcpServers.length > 0)
                throw COMMIT_REFUSALS.packageBlocked();
              pruneAnalyzed();
              const made = analyzedBy.get(params.analysisId);
              if (made?.id !== id) throw COMMIT_REFUSALS.analysisNotFound();
              if (made.revision !== params.expectedRevision)
                throw COMMIT_REFUSALS.packageStale();
              if (made.blocked) throw COMMIT_REFUSALS.packageBlocked();
              let committed: CollectionEntryCommit;
              try {
                committed = await host.commit({
                  analysisId: params.analysisId,
                  selectedOptionalResourceIds:
                    params.selectedOptionalResourceIds,
                  accountId: made.accountId,
                  signal: context.signal,
                });
              } catch (error) {
                if (context.signal.aborted) throw canopyCancelledError();
                throw error;
              }
              // A finished upload is answered even if the caller has gone:
              // it can't be withdrawn, so its replay must answer it.
              if (committed.status === 'refused') {
                // A refusal after the caller left records the cancel it saw.
                if (context.signal.aborted) throw canopyCancelledError();
                throw COMMIT_REFUSALS[committed.refusal]();
              }
              return {
                kind: 'collection' as const,
                mode: 'commit' as const,
                package: committed.package,
                committedPackageUploadId: committed.uploadId,
              };
            },
          });
        if (params.mode === 'install')
          throw notYet('Installing a shared collection package');
        if (
          params.dismissedInvocations !== undefined &&
          !storableDismissals(params.dismissedInvocations)
        )
          throw fail(
            'invalid_argument',
            `Dismiss at most ${PIPELINE_PACKAGE_MAX_INVOCATION_DISMISSALS} invocations, each one the analysis offered.`,
          );
        return runs.run({
          kind: 'core.catalog.entry.import',
          context,
          params,
          codes: CATALOG_COLLECTION_OPERATION_CODES.import,
          keyReused,
          decode: (outcome) =>
            CatalogCollectionImportResultSchema.safeParse(outcome).data ?? null,
          effect: () => {
            const id = storeIdOf(params.entryId);
            return inTurn(id, async () => {
              // Cancelled while it waited: nothing is read or analyzed.
              if (context.signal.aborted) throw canopyCancelledError();
              // The read authorizes as entry.get's does; an MCP member is
              // refused after it and before anything reads its connections.
              const read = await host.read(id);
              // Cancelled during the read: record that, never a blocked answer.
              if (context.signal.aborted) throw canopyCancelledError();
              if (read.status === 'missing') throw notFound();
              if (read.status === 'unreadable') throw unreadable();
              if (read.entry.revision !== params.expectedRevision)
                throw conflict(read.entry.revision);
              const { members } = read.entry;
              const blocked = mcpShareBlocked(members);
              if (blocked)
                return {
                  kind: 'collection' as const,
                  mode: 'analyze' as const,
                  analysis: blocked,
                };
              if (!documentNamesMembers(params.document, members))
                throw fail(
                  'failed_precondition',
                  "The share document doesn't match this collection's members.",
                  { code: codes.entryInvalid },
                );
              if (context.signal.aborted) throw canopyCancelledError();
              // The account a commit must upload under, read locally (no cloud
              // call) before and after the analysis: a switch in between
              // records none, so nothing made under one account uploads under
              // another.
              const accountBefore = await host.signedInAccountId();
              // The analyzer saves the request's dismissals.
              if (context.signal.aborted) throw canopyCancelledError();
              const analysis = await host.analyze({
                id,
                members,
                document: params.document,
                ...(params.dismissedInvocations !== undefined
                  ? { dismissedInvocations: params.dismissedInvocations }
                  : {}),
              });
              const accountAfter = await host.signedInAccountId();
              const accountId =
                accountBefore === accountAfter ? accountBefore : null;
              // A call the caller abandoned leaves nothing a commit could use.
              if (context.signal.aborted) {
                await host.dropAnalysis(analysis.analysisId);
                throw canopyCancelledError();
              }
              const result = {
                kind: 'collection' as const,
                mode: 'analyze' as const,
                analysis,
              };
              if (
                !CatalogCollectionImportResultSchema.safeParse(result).success
              ) {
                await host.dropAnalysis(analysis.analysisId);
                throw fail('internal', "This analysis can't be answered.");
              }
              if (!isBoundedCanopyJsonValue(result)) {
                await host.dropAnalysis(analysis.analysisId);
                throw fail(
                  'resource_exhausted',
                  'This analysis is too large to record.',
                );
              }
              analyzedBy.set(analysis.analysisId, {
                id,
                revision: read.entry.revision,
                blocked: analysis.state === 'blocked',
                expiresAt: Date.parse(analysis.expiresAt),
                accountId,
              });
              pruneAnalyzed();
              return result;
            });
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
