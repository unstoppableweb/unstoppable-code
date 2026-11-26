import type {
  CollectionEntryAnalysisRequest,
  CollectionEntryCommit,
  CollectionEntryCommitRefusal,
  CollectionEntryCorruptRemoval,
  CollectionEntryDraft,
  CollectionEntryManagement,
  CollectionEntryRead,
  CollectionEntryRemoval,
  CollectionEntryWrite,
  CollectionImportReadinessRead,
  CollectionImportReadinessRefusal,
  CoreCollectionEntryHost,
  StoredCollectionEntry,
} from '@canopy/core-runtime/node/catalog';
import { setImmediate } from 'node:timers/promises';
import {
  CatalogCollectionEntrySchema,
  CatalogCollectionRevisionSchema,
  collectionEntryId,
  type CatalogCollectionAnalysis,
} from '@canopy/protocol/canopy-core';
import {
  COLLECTION_SHARE_SCOPES,
  serializeSharedCollectionForHash,
  type CollectionShareScope,
} from '@canopy/protocol/collections';
import {
  countCapabilityPackageDistinctFiles,
  isDismissibleInvocationToken,
  type PipelinePackageAnalysisSummary,
  type PipelinePackageEnvironmentRequirement,
  type PipelinePackageRef,
} from '@canopy/protocol/pipelines';
import type { ShareFailureKind } from '@canopy/protocol/sharing';
import type {
  AnalyzeSubjectCapabilityPackageInput,
  probePipelinePackageRequirement,
} from '../pipelines/pipeline-package-service';
import type { CanopyCloudCredentialContext } from '../canopy-cloud/client';
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
  /** The shared package analyzer's subject analysis (CAN-4170 PR 4a). */
  analyze(
    input: AnalyzeSubjectCapabilityPackageInput,
  ): Promise<PipelinePackageAnalysisSummary>;
  cancelAnalysis(analysisId: string): Promise<void>;
  /** Whether the package service still holds the analysis (CAN-4170 PR 4c). */
  analysisLive(analysisId: string): Promise<boolean>;
  /** The signed-in account's id from the local account store; no network. */
  signedInAccountId(): Promise<string | null>;
  /** The one cloud account a commit checks the capability with and uploads under. */
  commitAccount(): Promise<CanopyCloudCredentialContext>;
  commit(
    request: { analysisId: string; selectedOptionalResourceIds: string[] },
    account: CanopyCloudCredentialContext,
    stillInTime: () => void,
  ): Promise<{ package: PipelinePackageRef; uploadId: string }>;
  /**
   * A shared collection's hash, package and probed requirements (PR 4b-1):
   * a scoped share as the import readiness channel reads it, a public one
   * from its public snapshot through the same requirement probes.
   */
  importReadiness(
    remoteId: string,
    fromPublicShare: boolean,
    signal: AbortSignal,
  ): Promise<{
    contentHash: string;
    package: PipelinePackageRef | null;
    requirements: Array<
      PipelinePackageEnvironmentRequirement & {
        status: 'available' | 'missing' | 'unknown';
      }
    >;
  }>;
}

const COLLECTIONS_CAPABILITY = 'collections-crud-v1';

/**
 * A share is another account's input with no byte cap on its read, so the
 * answer is bounded instead: by the renderer relay's reply cap
 * (RENDERER_RELAY_LIMITS.maxReplyBytes), past which it is refused as too large.
 */
const READINESS_MAX_ANSWER_BYTES = 1024 * 1024;
const READINESS_PROBE_CONCURRENCY = 8;

function stillWanted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('The readiness read was cancelled.');
}

/** A share whose answer can't fit, refused before any probe runs. */
class ReadinessTooLargeError extends Error {
  constructor() {
    super("The shared collection's requirements are too large to answer.");
  }
}

const ESCAPE_CHUNK = 64 * 1024;

/**
 * The UTF-8 bytes JSON.stringify writes for a string, without its quotes,
 * counted a chunk at a time; it stops once past `budget`.
 */
function escapedBytes(text: string, budget: number): number {
  let bytes = 0;
  for (let start = 0; start < text.length && bytes <= budget; ) {
    let end = Math.min(start + ESCAPE_CHUNK, text.length);
    // Keep a surrogate pair in one chunk.
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      end += 1;
    bytes += Buffer.byteLength(JSON.stringify(text.slice(start, end))) - 2;
    start = end;
  }
  return bytes;
}

/**
 * Refuses a share before any probe when its answer must pass the cap. Each
 * requirement is projected as `missing`, no longer than any status it can get,
 * and the running total stops at the cap, so no oversize string is built.
 */
function answerable(
  remoteId: string,
  share: {
    contentHash: string;
    package?: {
      version: number;
      digest: string;
      environmentRequirements: readonly PipelinePackageEnvironmentRequirement[];
    } | null;
  },
): void {
  const pkg = share.package;
  // Less the comma the first requirement doesn't take.
  let bytes =
    Buffer.byteLength(
      JSON.stringify({
        read: 'importReadiness',
        readiness: {
          remoteId,
          contentHash: share.contentHash,
          package: pkg ? { version: pkg.version, digest: pkg.digest } : null,
          requirements: [],
        },
      }),
    ) - 1;
  for (const requirement of pkg?.environmentRequirements ?? []) {
    // A row that can't fit is refused without serializing it.
    let fields = bytes;
    for (const text of [
      requirement.id,
      requirement.displayName,
      requirement.setupHint,
    ]) {
      // UTF-16 length is a lower bound on the escaped bytes.
      if (fields + text.length > READINESS_MAX_ANSWER_BYTES)
        throw new ReadinessTooLargeError();
      fields += escapedBytes(text, READINESS_MAX_ANSWER_BYTES - fields);
      if (fields > READINESS_MAX_ANSWER_BYTES)
        throw new ReadinessTooLargeError();
    }
    bytes +=
      Buffer.byteLength(
        JSON.stringify({
          id: requirement.id,
          kind: requirement.kind,
          displayName: requirement.displayName,
          required: requirement.required,
          setupHint: requirement.setupHint,
          status: 'missing',
        }),
      ) + 1;
    if (bytes > READINESS_MAX_ANSWER_BYTES) throw new ReadinessTooLargeError();
  }
}

/**
 * The requirement probe for one readiness read: once per kind and name (all
 * it reads), at most 8 at a time, and none once the read is cancelled.
 */
function boundedProbe(
  probe: typeof probePipelinePackageRequirement,
  signal: AbortSignal,
): typeof probePipelinePackageRequirement {
  const answers = new Map<string, ReturnType<typeof probe>>();
  const waiting: Array<() => void> = [];
  let running = 0;
  const run: typeof probe = async (requirement) => {
    if (running < READINESS_PROBE_CONCURRENCY) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      // PATH probes are synchronous; yield so a cancel can land between them.
      await setImmediate();
      stillWanted(signal);
      return await probe(requirement);
    } finally {
      // A finished probe hands its slot to the next one waiting.
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
  return (requirement) => {
    const key = `${requirement.kind}:${requirement.displayName}`;
    const known = answers.get(key);
    if (known) return known;
    const answer = run(requirement);
    answers.set(key, answer);
    return answer;
  };
}

/**
 * CAN-4170 PR 4c: the answer to each way a commit's upload fails; a null
 * answer is internal. A dependency review means the analysis's files changed;
 * a missing one, that it expired or was dropped.
 */
const COMMIT_FAILURES: Record<
  ShareFailureKind | 'blocked' | 'missing',
  CollectionEntryCommitRefusal | null
> = {
  blocked: 'packageBlocked',
  missing: 'analysisNotFound',
  'dependency-review': 'packageStale',
  authentication: 'remoteAccessDenied',
  permission: 'remoteAccessDenied',
  'organization-plan': 'remoteAccessDenied',
  connection: 'remoteUnavailable',
  unavailable: 'remoteUnavailable',
  conflict: null,
  unknown: null,
};

/** A failed capability check, before any share was read. */
class ReadinessCapabilityError extends Error {
  constructor(readonly failure: unknown) {
    super('The collections capability check failed.');
  }
}

/** CAN-4170 PR 4b-1: the answer to a readiness read that failed; null is internal. */
async function readinessFailure(
  error: unknown,
): Promise<CollectionImportReadinessRefusal | null> {
  if (error instanceof ReadinessTooLargeError) return 'answerTooLarge';
  if (error instanceof ReadinessCapabilityError) {
    // No share was read, so a 404 here can't mean the share is missing.
    const refusal = await readinessFailure(error.failure);
    return refusal === 'remoteNotFound' ? 'remoteUnavailable' : refusal;
  }
  const [
    { CanopyCloudClientError },
    { CanopyCloudConfigError },
    { isResourceContextRefusal },
  ] = await Promise.all([
    import('../canopy-cloud/client'),
    import('../canopy-cloud/config'),
    import('../lib/resource-context-error'),
  ]);
  // No cloud configured, or a local-only build: the share can't be read.
  if (
    isResourceContextRefusal(error) ||
    error instanceof CanopyCloudConfigError
  )
    return 'remoteAccessDenied';
  if (!(error instanceof CanopyCloudClientError)) return null;
  if (error.status === 404) return 'remoteNotFound';
  if (
    error.status === 401 ||
    error.status === 403 ||
    error.code === 'missing-api-key' ||
    error.code === 'cloud-not-configured'
  )
    return 'remoteAccessDenied';
  return 'remoteUnavailable';
}

async function commitFailure(
  error: unknown,
): Promise<ShareFailureKind | 'blocked' | 'missing'> {
  const {
    PackageAnalysisBlockedError,
    PackageAnalysisMissingError,
    ShareStageError,
    SkillSecretDetectedError,
    shareFailureFromError,
  } = await import('../sharing/share-operation-result');
  const cause = error instanceof ShareStageError ? error.failureCause : error;
  if (cause instanceof PackageAnalysisMissingError) return 'missing';
  if (
    cause instanceof PackageAnalysisBlockedError ||
    cause instanceof SkillSecretDetectedError
  )
    return 'blocked';
  return shareFailureFromError(error, 'prepare', { writeSent: true }).kind;
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
  analyze: async (input) =>
    (
      await import('../pipelines/pipeline-package-service')
    ).analyzeSubjectCapabilityPackage(input),
  cancelAnalysis: async (analysisId) => {
    (
      await import('../pipelines/pipeline-package-service')
    ).cancelPackageAnalysis(analysisId);
  },
  analysisLive: async (analysisId) =>
    (
      await import('../pipelines/pipeline-package-service')
    ).packageAnalysisConsentFacts(analysisId, []) !== null,
  signedInAccountId: async () =>
    (
      await (
        await import('../lib/canopy-cloud-account-store')
      ).loadCanopyCloudAccount()
    )?.account?.id ?? null,
  commitAccount: async () =>
    (
      await import('../canopy-cloud/client')
    ).resolveCanopyCloudCredentialContextWithCapability(COLLECTIONS_CAPABILITY),
  importReadiness: async (remoteId, fromPublicShare, signal) => {
    const service = await import('../pipelines/pipeline-package-service');
    // The shared MCP status read evicts a token bound to an upstream other
    // than the local server's, as every status read does; a share names only
    // which local server is read.
    const probe = boundedProbe(service.probePipelinePackageRequirement, signal);
    if (!fromPublicShare) {
      // The import readiness channel's own capability check and read.
      const [client, context, handlers, server] = await Promise.all([
        import('../canopy-cloud/client'),
        import('../lib/resource-context'),
        import('../collections/collection-handlers'),
        import('../collections/canopy-server-client'),
      ]);
      const account = await context.resourceAccountSnapshot();
      const selection = context.resourceContextEnabled()
        ? await context.resourceContextSnapshot()
        : undefined;
      try {
        // Explicit credentials, so live discovery saves nothing to the account.
        await client.assertCanopyCloudCapability(
          COLLECTIONS_CAPABILITY,
          await client.resolveCanopyCloudCredentialContext(),
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ReadinessCapabilityError(error);
      }
      const { collection, requirements } =
        await handlers.inspectSharedCollectionImport(remoteId, {
          getCollection: async (id) => {
            stillWanted(signal);
            const shared = await server.getSharedCollection(id, signal);
            answerable(remoteId, shared);
            return shared;
          },
          probeRequirement: probe,
        });
      // The probes awaited after the share read; the account or the
      // selected context may have moved.
      await context.assertResourceAccountSnapshot(account);
      if (selection !== undefined)
        await context.assertResourceContextSnapshot(selection);
      return {
        contentHash: collection.contentHash,
        package: collection.package ?? null,
        requirements,
      };
    }
    const [{ getPublicCollectionShareSnapshot }, context] = await Promise.all([
      import('../canopy-cloud/public-share-client'),
      import('../lib/resource-context'),
    ]);
    // The probes read the signed-in account's MCP connections.
    const account = await context.resourceAccountSnapshot();
    const selection = context.resourceContextEnabled()
      ? await context.resourceContextSnapshot()
      : undefined;
    stillWanted(signal);
    const snapshot = await getPublicCollectionShareSnapshot(remoteId, signal);
    answerable(remoteId, snapshot);
    const readiness = snapshot.package
      ? await service.evaluatePipelinePackageRequirements(
          snapshot.package.environmentRequirements,
          probe,
        )
      : null;
    await context.assertResourceAccountSnapshot(account);
    if (selection !== undefined)
      await context.assertResourceContextSnapshot(selection);
    return {
      contentHash: snapshot.contentHash,
      package: snapshot.package ?? null,
      requirements: readiness?.requirements ?? [],
    };
  },
  commit: async (request, account, stillInTime) => {
    const committed = await (
      await import('../pipelines/pipeline-package-service')
    ).createSubjectCapabilityPackage(request, undefined, account, stillInTime);
    return {
      package: committed.capabilityPackage,
      uploadId: committed.committedPackageUploadId,
    };
  },
};

/** The analyzer's summary as the contract answers it (CAN-4170 PR 4a). */
function analysisOf(
  summary: PipelinePackageAnalysisSummary,
): CatalogCollectionAnalysis {
  return {
    analysisId: summary.analysisId,
    state: summary.state,
    blockers: summary.blockers.map((blocker) => ({
      code: blocker.code,
      subject: blocker.subject ?? null,
      message: blocker.message,
      // Only a dismissal the dismissal store can save is offered back.
      ...(blocker.dismissal &&
      isDismissibleInvocationToken(blocker.dismissal.token)
        ? { dismissal: blocker.dismissal }
        : {}),
    })),
    // A subject analysis answers its manifest; a built package, its summary.
    resources: summary.package
      ? summary.package.resources.map((resource) => ({
          resourceId: resource.id,
          displayName: resource.displayName,
          fileCount: resource.fileCount,
          totalBytes: resource.totalBytes,
        }))
      : (summary.manifest?.resources ?? []).map((resource) => {
          const { files, bytes } = countCapabilityPackageDistinctFiles([
            resource,
          ]);
          return {
            resourceId: resource.id,
            displayName: resource.displayName,
            fileCount: files,
            totalBytes: bytes,
          };
        }),
    requirements: (
      summary.package?.environmentRequirements ??
      summary.manifest?.environmentRequirements ??
      []
    ).map((requirement) => ({
      id: requirement.id,
      kind: requirement.kind,
      displayName: requirement.displayName,
      required: requirement.required,
      setupHint: requirement.setupHint,
    })),
    unpackageableMemberLabels: summary.unpackageableSelectionLabels ?? [],
    dismissedInvocations: summary.dismissedInvocations ?? [],
    expiresAt: summary.expiresAt,
  };
}

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
    async analyze(
      request: CollectionEntryAnalysisRequest,
    ): Promise<CatalogCollectionAnalysis> {
      return analysisOf(
        await store.analyze({
          rawContent: serializeSharedCollectionForHash(
            request.document.rawCollection,
          ),
          scopeKey: `collection:${request.id}`,
          selections: {
            collectionIds: [],
            skillRefs: request.members.skills,
            pluginRefs: request.members.plugins,
            mcpServerRefs: request.members.mcpServers,
          },
          ...(request.dismissedInvocations !== undefined
            ? { dismissedInvocations: request.dismissedInvocations }
            : {}),
        }),
      );
    },
    dropAnalysis: (analysisId) => store.cancelAnalysis(analysisId),
    signedInAccountId: () => store.signedInAccountId(),
    async commit({
      analysisId,
      selectedOptionalResourceIds,
      accountId,
      signal,
    }): Promise<CollectionEntryCommit> {
      // Before any cloud call: an analysis the service dropped or expired, or
      // one made with no account signed in (Nick's N2).
      if (accountId === null || !(await store.analysisLive(analysisId)))
        return { status: 'refused', refusal: 'analysisNotFound' };
      // Nick's N2: another account signed in is refused from the local
      // store, before its capability is read.
      if ((await store.signedInAccountId()) !== accountId)
        return { status: 'refused', refusal: 'analysisNotFound' };
      // Cancelled meanwhile: no capability read.
      if (signal.aborted) throw new Error('The commit was cancelled.');
      try {
        const account = await store.commitAccount();
        // An account switched since the local read, or during the capability
        // read, is never uploaded under.
        if (
          account.account?.id !== accountId ||
          (await store.signedInAccountId()) !== accountId
        )
          return { status: 'refused', refusal: 'analysisNotFound' };
        const committed = await store.commit(
          { analysisId, selectedOptionalResourceIds },
          account,
          () => {
            if (signal.aborted) throw new Error('The commit was cancelled.');
          },
        );
        return { status: 'committed', ...committed };
      } catch (error) {
        if (signal.aborted) throw error;
        // The account switched while its capability was read or the upload
        // ran: the analysis isn't this account's, whatever the cloud said.
        if ((await store.signedInAccountId()) !== accountId)
          return { status: 'refused', refusal: 'analysisNotFound' };
        const refusal = COMMIT_FAILURES[await commitFailure(error)];
        if (refusal === null) throw error;
        return { status: 'refused', refusal };
      }
    },
    async readImportReadiness(
      remoteId,
      fromPublicShare,
      signal,
    ): Promise<CollectionImportReadinessRead> {
      let read: Awaited<
        ReturnType<DesktopCollectionEntryStore['importReadiness']>
      >;
      try {
        read = await store.importReadiness(remoteId, fromPublicShare, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const refusal = await readinessFailure(error);
        if (refusal === null) throw error;
        return { status: 'refused', refusal };
      }
      const readiness = {
        remoteId,
        contentHash: read.contentHash,
        package: read.package
          ? { version: read.package.version, digest: read.package.digest }
          : null,
        requirements: read.requirements.map((requirement) => ({
          id: requirement.id,
          kind: requirement.kind,
          displayName: requirement.displayName,
          required: requirement.required,
          setupHint: requirement.setupHint,
          status: requirement.status,
        })),
      };
      if (
        Buffer.byteLength(
          JSON.stringify({ read: 'importReadiness', readiness }),
        ) > READINESS_MAX_ANSWER_BYTES
      )
        return { status: 'refused', refusal: 'answerTooLarge' };
      return { status: 'found', readiness };
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
