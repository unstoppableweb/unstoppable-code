import {
  SharedContainerReplicaRevisionUnavailableError,
  type SharedContainerReplicaRevisionSnapshot,
} from './types';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import {
  ciphertextLengthFor,
  createArtifactDecryptStream,
} from '@canopy/artifact-crypto';
import {
  isSharedContainerManifest,
  isSharedContainerRevisionPackage,
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
  MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES,
  type SharedContainerArtifactDetail,
  type SharedContainerArtifactKey,
  type SharedContainerDownloadTarget,
  type SharedContainerManifest,
  type SharedContainerRevisionDetail,
  isAnySharedContainerRevisionLayout,
  MAX_SUPPORTED_SHARED_CONTAINER_SCHEMA_VERSION,
} from '@canopy/protocol/shared-containers';
import { pathExists } from '../../lib/fs-utils';
import { isErrnoException } from '../../lib/type-guards';
import {
  getSharedContainersRootDir,
  getWorktreeDataRootDir,
} from '../../lib/paths';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type SharedContainerAccess,
} from '@canopy/desktop-shared/types';
import type { SharedContainerViewerLayoutMode } from '../layout-projection';
import type { SharedContainerReplicaTransport } from '../transport';
import {
  resolveSharedContainerAccess,
  sharedContainerRecipientScopeKey,
} from '../owner-scope';
import { materializeCodeRevision } from '../materialize/code';
import { materializeCoworkRevision } from '../materialize/cowork';
import {
  resolveMaterializedPath,
  validateMaterializedRelativePath,
} from '../materialize/path-safety';
import { validateSharedContainerProjectionBudget } from '../materialize/projection-budget';
import {
  makeReplicaTreeReadOnly,
  makeReplicaTreeWritable,
  SharedContainerReplicaStore,
} from './store';
import type {
  SharedContainerReplicaState,
  SharedContainerSyncPhase,
  SharedContainerSyncPhaseEvent,
} from './types';
import type { SharedContainerCachedArtifact } from './types';

type ReplicaFetch = typeof fetch;

/**
 * Signals that authoritative replica deletion completed even though derived
 * recipient view-state cleanup failed. Callers must announce the purge before
 * rethrowing {@link cleanupFailure}.
 */
export class SharedContainerReplicaPurgedCleanupError extends Error {
  constructor(readonly cleanupFailure: unknown) {
    super(
      cleanupFailure instanceof Error
        ? cleanupFailure.message
        : 'Shared-container recipient view-state cleanup failed',
    );
    this.name = 'SharedContainerReplicaPurgedCleanupError';
  }
}

interface PromotedRevision {
  backupDir: string;
  containerId: string;
  hadPrevious: boolean;
  markerPath: string;
  promotionId: string;
}

/**
 * Breadcrumb marking a revision whose checkouts are on loan to a staging tree.
 *
 * Seeding moves checkouts out of the previous revision rather than copying
 * them, which is O(1) but not crash-safe: a quit or kill between the move and
 * `discardStaging` would leave the retained revision indexed as `available`
 * with checkouts that are no longer on disk, and the cached-revision check only
 * verifies the revision directory itself. The marker survives that crash, so
 * the next sync rematerializes instead of trusting the entry (CAN-2551).
 *
 * The leading dot keeps it out of the repository namespace: manifest repo ids
 * are validated against `/^[A-Za-z0-9_-]+$/`, so no declared repository can
 * ever be named this. Note that path validation does *not* reject the name —
 * it is the repo-id contract above, plus the fact that a marker is only ever
 * written after `readdir` has already run, that keeps seeding from mistaking
 * it for a checkout.
 */
export const BORROWED_CHECKOUT_MARKER = '.canopy-borrowed';

/** A previous-revision checkout borrowed by the in-flight staging tree. */
interface SeededCheckout {
  repoId: string;
  previousPath: string;
  stagingPath: string;
}

/** The outcome of seeding staging from the previous revision's checkouts. */
interface SeededCheckouts {
  /**
   * The previous revision's `repos/` directory, unsealed so entries could be
   * renamed out of it. Non-null only while it still needs re-sealing.
   */
  previousReposDir: string | null;
  checkouts: SeededCheckout[];
  /**
   * Repositories materialization has begun writing into.
   *
   * `materializeGitCommitRaw` wipes every non-`.git` entry and rewrites the
   * working tree in place, and the overlay is written on top, so a repository
   * named here holds the **new** revision's content. Putting such a tree back
   * would leave the retained revision serving files that do not match its own
   * layout — silently, since the index entry still reads `available`.
   *
   * Tracked per repository rather than as one call-wide flag: a new repository
   * failing to materialize says nothing about a borrowed one the materializer
   * never reached, and invalidating on that would force a full re-clone of
   * every repository for an unrelated failure (CAN-2551).
   */
  mutatedRepoIds: Set<string>;
}

interface PromotionMarker {
  version: 1 | 2;
  hadPrevious: boolean;
  phase: 'prepared' | 'committed';
  containerId?: string;
  promotionId?: string;
}

export interface SharedContainerReplicaManagerOptions {
  rootDir?: string;
  transport: SharedContainerReplicaTransport;
  fetchImpl?: ReplicaFetch;
  materializeCodeRevision?: typeof materializeCodeRevision;
  sealReplicaTree?: typeof makeReplicaTreeReadOnly;
  maxReplicaRootBytes?: bigint;
  syncReservationBytes?: bigint;
  cleanupViewState?: (containerId: string) => Promise<void>;
  /**
   * `mode` is `reset` only for a sync started by the recipient's open, which
   * replaces their layout with the publisher's. Every other sync seeds.
   */
  projectViewerChats?: (
    containerId: string,
    revisionId: string,
    options: { mode: SharedContainerViewerLayoutMode },
  ) => Promise<void>;
  refreshViewerBrowsers?: (containerId: string) => Promise<void>;
  /**
   * Coarse progress for the recipient surface. A cold open runs access checks,
   * artifact downloads, a git checkout and a recursive seal; reporting them
   * separately is what keeps a multi-second checkout from reading as a hang
   * under a label that only describes the first step (CAN-2551).
   */
  onPhase?: (event: SharedContainerSyncPhaseEvent) => void;
  /**
   * Fired for each container removed by an authorization snapshot fence, which
   * purges below the reconciliation service rather than through it. Without
   * this the removal is unattributable: no `shared_container_replica_purged`
   * diagnostic and no scoped renderer broadcast, so a recipient whose access
   * was revoked keeps a decrypted transcript on screen with nothing to explain
   * where the bytes went. The service's own purge paths do NOT route through
   * here -- they already emit -- so this must stay scoped to the fence.
   */
  /** `scopeKey` is the listing scope whose snapshot removed the replica. */
  onSnapshotContainerPurged?: (containerId: string, scopeKey: string) => void;
  /**
   * The authoritative set of container ids a whole-store purge is about to
   * remove, reported while the index can still name them. The reconciliation
   * service knows only what it was actively tracking, so without this an
   * accepted-but-closed share loses its plaintext unattributed.
   */
  onPurgeAllScope?: (containerIds: readonly string[]) => void;
}

const DEFAULT_SYNC_RESERVATION_BYTES =
  BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES) * BigInt(5);
const DEFAULT_MAX_REPLICA_ROOT_BYTES =
  DEFAULT_SYNC_RESERVATION_BYTES * BigInt(4);
const FILESYSTEM_BLOCK_BYTES = BigInt(512);
const CONSERVATIVE_ALLOCATION_UNIT_BYTES = BigInt(64 * 1024);

function allocatedEntryBytes(info: Awaited<ReturnType<typeof lstat>>): bigint {
  const allocatedBlocks = BigInt(info.blocks) * FILESYSTEM_BLOCK_BYTES;
  if (allocatedBlocks > BigInt(0)) return allocatedBlocks;
  const reportedBlockSize = BigInt(info.blksize);
  const allocationUnit =
    reportedBlockSize > CONSERVATIVE_ALLOCATION_UNIT_BYTES
      ? reportedBlockSize
      : CONSERVATIVE_ALLOCATION_UNIT_BYTES;
  const logicalBytes = BigInt(info.size);
  return (
    (((logicalBytes > BigInt(0) ? logicalBytes : BigInt(1)) +
      allocationUnit -
      BigInt(1)) /
      allocationUnit) *
    allocationUnit
  );
}

/**
 * Path segments, relative to the walked root, of a subtree to leave out of the
 * measured total. Used to exclude Git base checkouts: those bytes come from the
 * recipient's own authenticated repository access, are not downloaded from the
 * container storage the reservation governs, and counting them would reimpose
 * the size ceiling the accept step replaced.
 */
type AllocatedSizeSkip = (segments: readonly string[]) => boolean;

async function directoryAllocatedSizeWithoutFollowingLinks(
  root: string,
  skip?: AllocatedSizeSkip,
  segments: readonly string[] = [],
): Promise<bigint> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return BigInt(0);
    throw error;
  }
  let total = BigInt(0);
  for (const entry of entries) {
    const entrySegments = [...segments, entry.name];
    if (skip?.(entrySegments) === true) continue;
    const path = join(root, entry.name);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      // Purged since the readdir (a listing snapshot removing another
      // share's replica): it no longer holds any bytes.
      if (isErrnoException(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    total += allocatedEntryBytes(info);
    if (entry.isDirectory()) {
      total += await directoryAllocatedSizeWithoutFollowingLinks(
        path,
        skip,
        entrySegments,
      );
    }
  }
  return total;
}

/** `repos` directly inside one staging revision directory. */
const skipStagingBaseCheckout: AllocatedSizeSkip = (segments) =>
  segments.length === 1 && segments[0] === 'repos';

/**
 * `{containerId}/{staging|revisions}/{revisionId}/repos`, including the
 * `.previous` backup a promotion leaves behind.
 */
const skipReplicaRootBaseCheckouts: AllocatedSizeSkip = (segments) =>
  segments.length === 4 &&
  segments[3] === 'repos' &&
  (segments[1] === 'staging' || segments[1] === 'revisions');

const ARTIFACT_PATH =
  /^(?:container\.json|(?:chats|plans)\/[A-Za-z0-9_-]+\.json|(?:notes|prompts)\/[A-Za-z0-9_-]+\.md|(?:attachments|files)\/[a-f0-9]{64}|repos\/[A-Za-z0-9_-]+\/(?:files|snapshot)\/[a-f0-9]{64})$/;

function digestHex(value: string): string {
  return value.toLowerCase().replace(/^sha256:/, '');
}

function parseManifest(value: unknown): SharedContainerManifest {
  if (!isSharedContainerManifest(value)) {
    throw new Error('Shared-container manifest has an invalid shape');
  }
  return value;
}

function validateRevisionId(value: string): string {
  try {
    const normalized = validateMaterializedRelativePath(value);
    if (normalized !== value || normalized.includes('/')) {
      throw new Error('Revision ids must be one canonical path segment');
    }
    return normalized;
  } catch {
    throw new Error('Shared-container revision has an invalid id');
  }
}

function resolveRevisionDirectory(root: string, revisionId: string): string {
  return resolveMaterializedPath(root, validateRevisionId(revisionId));
}

function validateArtifactSet(
  revision: SharedContainerRevisionDetail,
  manifest: SharedContainerManifest,
): void {
  if (manifest.revisionId !== revision.id) {
    throw new Error('Shared-container manifest revision does not match');
  }
  if (manifest.schemaVersion !== revision.schemaVersion) {
    throw new Error('Shared-container manifest schema does not match');
  }
  if (manifest.parentRevisionId !== revision.parentRevisionId) {
    throw new Error('Shared-container manifest parent does not match');
  }
  // Position is not assertable: the server rebuilds both the manifest and the
  // REST list from rows read back with `orderBy: { path: 'asc' }`
  // (`apps/web/src/lib/shared-containers/revision-publish-service.ts`), so
  // `chats/...` and `attachments/...` always sort ahead of `container.json`
  // regardless of the order the publisher declared. Require presence instead.
  if (
    !manifest.artifacts.some((artifact) => artifact.path === 'container.json')
  ) {
    throw new Error('Shared-container manifest must declare container.json');
  }
  const artifactIds = new Set<string>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const artifact of manifest.artifacts) {
    if (!ARTIFACT_PATH.test(artifact.path)) {
      throw new Error(
        `Invalid shared-container artifact path: ${artifact.path}`,
      );
    }
    if (artifactIds.has(artifact.artifactId) || paths.has(artifact.path)) {
      throw new Error('Shared-container manifest contains duplicate artifacts');
    }
    artifactIds.add(artifact.artifactId);
    paths.add(artifact.path.normalize('NFC'));
    const size = Number(artifact.objectSizeBytes);
    if (
      !Number.isSafeInteger(size) ||
      size > MAX_SHARED_CONTAINER_ARTIFACT_BYTES
    ) {
      throw new Error(
        `Shared-container artifact exceeds the size limit: ${artifact.path}`,
      );
    }
    totalBytes += size;
    if (totalBytes > MAX_SHARED_CONTAINER_REVISION_BYTES) {
      throw new Error('Shared-container revision exceeds the size limit');
    }
    if (artifact.representation !== 'BLOB') {
      throw new Error(
        `Unsupported shared-container representation: ${artifact.representation}`,
      );
    }
  }
  const restArtifacts = revision.artifacts;
  if (
    !restArtifacts ||
    JSON.stringify(restArtifacts) !== JSON.stringify(manifest.artifacts)
  ) {
    throw new Error(
      'Shared-container REST artifact list does not match its authenticated manifest',
    );
  }
}

function decodeKey(key: SharedContainerArtifactKey): Buffer {
  if (key.scheme !== 'AES_256_GCM_CHUNKED_V1') {
    throw new Error('Unsupported shared-container artifact key scheme');
  }
  const decoded = Buffer.from(key.dataKey, 'base64');
  if (decoded.byteLength !== 32) {
    throw new Error('Invalid shared-container data key');
  }
  return decoded;
}

function boundedHashingTransform(
  hash: ReturnType<typeof createHash>,
  maximumBytes: bigint,
): Transform {
  let bytes = BigInt(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      bytes += BigInt(chunk.byteLength);
      if (bytes > maximumBytes) {
        callback(
          new Error('Shared-container ciphertext exceeds its declared size'),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

export class SharedContainerReplicaManager {
  readonly store: SharedContainerReplicaStore;
  private readonly transport: SharedContainerReplicaTransport;
  private readonly fetchImpl: ReplicaFetch;
  private readonly materializeCode: typeof materializeCodeRevision;
  private readonly sealReplicaTree: typeof makeReplicaTreeReadOnly;
  private readonly maxReplicaRootBytes: bigint;
  private readonly syncReservationBytes: bigint;
  private readonly cleanupViewState: (containerId: string) => Promise<void>;
  private readonly projectViewerChats: (
    containerId: string,
    revisionId: string,
    options: { mode: SharedContainerViewerLayoutMode },
  ) => Promise<void>;
  private readonly refreshViewerBrowsers: (
    containerId: string,
  ) => Promise<void>;
  private readonly onPhase: (event: SharedContainerSyncPhaseEvent) => void;
  private readonly onSnapshotContainerPurged: (
    containerId: string,
    scopeKey: string,
  ) => void;
  private readonly onPurgeAllScope: (containerIds: readonly string[]) => void;
  private readonly pendingViewStateCleanup = new Set<string>();
  private reservedReplicaBytes = BigInt(0);
  private storageReservationTail: Promise<void> = Promise.resolve();
  private purgingAll = false;
  private purgeAllPromise: Promise<void> | null = null;
  private purgeAllResultPromise: Promise<unknown> | null = null;
  private purgeGeneration = 0;
  private authorizationGeneration = 0;
  private authorizationTransitioning = false;
  private authorizationTransitionFence: Promise<void> | null = null;
  private authorizationMutationTail: Promise<void> = Promise.resolve();
  private organizationSnapshotFencePromise: Promise<void> | null = null;
  private authorizedOrganizationsDuringSnapshot: ReadonlySet<string> | null =
    null;
  private containerSnapshotFencePromise: Promise<void> | null = null;
  /**
   * A cursor-less listing's complete answer for one recipient scope: an
   * organization id, or `DIRECT_SHARED_CONTAINER_SCOPE_KEY` for direct shares
   * (see `sharedContainerRecipientScopeKey`).
   */
  private containerSnapshot: {
    scopeKey: string;
    authorizedContainerIds: ReadonlySet<string>;
  } | null = null;
  private nextContainerSnapshotListingGeneration = 0;
  private readonly currentContainerSnapshotListingGenerations = new Map<
    string,
    number
  >();
  private readonly containerPurgePromises = new Map<string, Promise<void>>();
  private readonly containerPurgeGenerations = new Map<string, number>();
  private readonly active = new Map<
    string,
    {
      controller: AbortController;
      /** Absent for a personal container shared directly. */
      organizationId?: string;
      access: SharedContainerAccess;
      viewerLayoutMode: SharedContainerViewerLayoutMode;
      promise: Promise<SharedContainerReplicaState>;
    }
  >();

  constructor(options: SharedContainerReplicaManagerOptions) {
    this.store = new SharedContainerReplicaStore(
      options.rootDir ?? getSharedContainersRootDir(),
    );
    this.transport = options.transport;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.materializeCode =
      options.materializeCodeRevision ?? materializeCodeRevision;
    this.sealReplicaTree = options.sealReplicaTree ?? makeReplicaTreeReadOnly;
    this.maxReplicaRootBytes =
      options.maxReplicaRootBytes ?? DEFAULT_MAX_REPLICA_ROOT_BYTES;
    this.syncReservationBytes =
      options.syncReservationBytes ?? DEFAULT_SYNC_RESERVATION_BYTES;
    this.cleanupViewState =
      options.cleanupViewState ?? ((): Promise<void> => Promise.resolve());
    this.projectViewerChats =
      options.projectViewerChats ?? ((): Promise<void> => Promise.resolve());
    this.refreshViewerBrowsers =
      options.refreshViewerBrowsers ?? ((): Promise<void> => Promise.resolve());
    this.onPhase = options.onPhase ?? ((): void => undefined);
    this.onSnapshotContainerPurged =
      options.onSnapshotContainerPurged ?? ((): void => undefined);
    this.onPurgeAllScope = options.onPurgeAllScope ?? ((): void => undefined);
  }

  /** Report a whole-store purge's scope without letting a listener fault it. */
  private reportPurgeAllScope(containerIds: readonly string[]): void {
    try {
      this.onPurgeAllScope(containerIds);
    } catch {
      // Attribution is advisory.
    }
  }

  /**
   * Report a snapshot-fence removal without ever letting a listener fault the
   * purge. Attribution must never be the reason plaintext survives.
   */
  private reportSnapshotPurge(containerId: string, scopeKey: string): void {
    try {
      this.onSnapshotContainerPurged(containerId, scopeKey);
    } catch {
      // Attribution is advisory.
    }
  }

  /** Report progress without ever letting a listener fault a sync. */
  private reportPhase(
    containerId: string,
    phase: SharedContainerSyncPhase,
  ): void {
    try {
      this.onPhase({ containerId, phase });
    } catch {
      // Progress reporting is advisory.
    }
  }

  private async cleanupContainerViewState(containerId: string): Promise<void> {
    this.pendingViewStateCleanup.add(containerId);
    await this.cleanupViewState(containerId);
    this.pendingViewStateCleanup.delete(containerId);
  }

  getState(containerId: string): Promise<SharedContainerReplicaState | null> {
    return this.store.get(containerId);
  }

  captureAuthorizationGeneration(): number {
    return this.authorizationGeneration;
  }

  /** Whether an organization snapshot or purge-all transition is running. */
  isAuthorizationTransitioning(): boolean {
    return this.authorizationTransitionFence !== null;
  }

  /** Resolves once no authorization transition is running. */
  async settleAuthorizationTransition(): Promise<void> {
    while (this.authorizationTransitionFence) {
      await this.authorizationTransitionFence;
    }
  }

  /**
   * `scopeKey` is the listing's recipient scope: an organization id, or the
   * direct-share scope key for the organization-independent direct listing.
   */
  async beginContainerSnapshotListing(scopeKey: string): Promise<number> {
    return this.withAuthorizationMutationLock(() => {
      if (this.authorizationTransitioning || this.purgingAll) {
        throw new DOMException(
          'Replica authorization is changing',
          'AbortError',
        );
      }
      const generation = ++this.nextContainerSnapshotListingGeneration;
      this.currentContainerSnapshotListingGenerations.set(scopeKey, generation);
      return generation;
    });
  }

  /**
   * `organizationId` is the container's ownership hint (absent for a personal
   * container). `access` is how the recipient reached it; direct shares are
   * outside organization-snapshot reconciliation. It defaults to direct
   * without an organization and to organization access otherwise.
   */
  async sync(
    containerId: string,
    organizationId: string | undefined,
    options: {
      force?: boolean;
      access?: SharedContainerAccess;
      /** Defaults to `seed`. Only the recipient's open passes `reset`. */
      viewerLayoutMode?: SharedContainerViewerLayoutMode;
    } = {},
  ): Promise<SharedContainerReplicaState> {
    const viewerLayoutMode = options.viewerLayoutMode ?? 'seed';
    const access = resolveSharedContainerAccess(organizationId, options.access);
    const scopeKey = sharedContainerRecipientScopeKey(organizationId, access);
    if (this.purgingAll || this.authorizationTransitioning) {
      throw new DOMException('Replica cleanup is in progress', 'AbortError');
    }
    if (this.isOrganizationBlockedDuringSnapshot(organizationId, access)) {
      throw new DOMException(
        'Organization replica cleanup is in progress',
        'AbortError',
      );
    }
    if (this.containerPurgePromises.has(containerId)) {
      throw new DOMException('Replica cleanup is in progress', 'AbortError');
    }
    if (this.isContainerBlockedDuringSnapshot(containerId, scopeKey)) {
      throw new DOMException(
        'Container replica cleanup is in progress',
        'AbortError',
      );
    }
    const running = this.active.get(containerId);
    if (running) {
      if (
        running.organizationId !== organizationId ||
        running.access !== access
      ) {
        throw new DOMException(
          'A replica sync is active for a different organization',
          'AbortError',
        );
      }
      if (
        viewerLayoutMode !== 'reset' ||
        running.viewerLayoutMode === 'reset'
      ) {
        return running.promise;
      }
      // The reset belongs to the sync the open started. A realtime or
      // fallback sync already in flight keeps seeding; the open waits for it
      // and then runs its own sync. Each pass waits out one whole sync, and
      // background syncs are spaced by the fallback interval and coalesced
      // realtime signals, so the open is not held up indefinitely.
      await running.promise.catch(() => undefined);
      return this.sync(containerId, organizationId, options);
    }
    const authorizationGeneration = this.authorizationGeneration;
    const controller = new AbortController();
    const promise = (async (): Promise<SharedContainerReplicaState> => {
      const releaseStorage = await this.reserveReplicaStorage();
      try {
        return await this.performSync(
          containerId,
          organizationId,
          access,
          controller.signal,
          options.force === true,
          authorizationGeneration,
          viewerLayoutMode,
        );
      } finally {
        await releaseStorage();
      }
    })();
    this.active.set(containerId, {
      controller,
      ...(organizationId !== undefined ? { organizationId } : {}),
      access,
      viewerLayoutMode,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.active.get(containerId)?.promise === promise) {
        this.active.delete(containerId);
      }
    }
  }

  private async withStorageReservationLock<T>(
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.storageReservationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.storageReservationTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private reserveReplicaStorage(): Promise<() => Promise<void>> {
    return this.withStorageReservationLock(async () => {
      const usedBytes = await directoryAllocatedSizeWithoutFollowingLinks(
        this.store.rootDir,
        skipReplicaRootBaseCheckouts,
      );
      if (
        usedBytes + this.reservedReplicaBytes + this.syncReservationBytes >
        this.maxReplicaRootBytes
      ) {
        throw new Error('Shared-container replica storage quota exceeded');
      }
      this.reservedReplicaBytes += this.syncReservationBytes;
      let released = false;
      return async (): Promise<void> => {
        if (released) return;
        released = true;
        await this.withStorageReservationLock(() => {
          this.reservedReplicaBytes -= this.syncReservationBytes;
        });
      };
    });
  }

  private async assertStagingWithinReservation(
    stagingDir: string,
  ): Promise<void> {
    if (
      (await directoryAllocatedSizeWithoutFollowingLinks(
        stagingDir,
        skipStagingBaseCheckout,
      )) > this.syncReservationBytes
    ) {
      throw new Error('Shared-container replica storage quota exceeded');
    }
  }

  private async withContainerCleanup<T>(
    containerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.containerPurgePromises.get(containerId);
    this.containerPurgeGenerations.set(
      containerId,
      (this.containerPurgeGenerations.get(containerId) ?? 0) + 1,
    );
    const result = (async (): Promise<T> => {
      await previous?.catch(() => undefined);
      return operation();
    })();
    const fence = result.then(
      () => undefined,
      () => undefined,
    );
    this.containerPurgePromises.set(containerId, fence);
    try {
      return await result;
    } finally {
      if (this.containerPurgePromises.get(containerId) === fence) {
        this.containerPurgePromises.delete(containerId);
      }
    }
  }

  /**
   * Purge an unpinned replica's bytes.
   *
   * **This has no production caller and must not gain one lightly (CAN-2551).**
   * The reconciliation service used to call it from `close()`, which meant
   * every navigation away from the viewer deleted the decrypted replica —
   * including the base git checkout — so the next open paid for two HTTPS round
   * trips, a full artifact re-download, three GitHub API calls per repository,
   * and a fresh `git clone`, all under one indeterminate spinner. Plaintext now
   * lives as long as the acceptance does, and the only paths that may remove it
   * are the recipient's own Remove/Decline, access loss, an organization-snapshot
   * reconcile, and account change — each of which goes through `purge`.
   *
   * It is kept rather than deleted because it is the tested expression of the
   * "release an unpinned container's bytes" transition, and the pinning work it
   * pairs with ({@link pin}) is still unfinished. Anything that wants to free a
   * replica today wants `purge`.
   */
  async close(containerId: string): Promise<boolean> {
    while (true) {
      if (this.purgingAll && this.purgeAllResultPromise) {
        await this.purgeAllResultPromise;
        return true;
      }
      const transitionFence = this.authorizationTransitionFence;
      if (transitionFence) {
        await transitionFence;
        continue;
      }
      const authorizationGeneration = this.authorizationGeneration;
      try {
        return await this.withContainerCleanup(containerId, async () => {
          const running = this.active.get(containerId);
          if (running) {
            running.controller.abort();
            await running.promise.catch(() => undefined);
          }
          return this.withReplicaMutation(
            authorizationGeneration,
            containerId,
            running ? this.activeScopeKey(running) : undefined,
            async () => {
              const state = await this.store.get(containerId);
              if (state?.status === 'pinned') return false;
              // Remove discoverability first. Integrity recovery handles any
              // bytes left behind if process termination interrupts the
              // physical purge.
              await this.store.delete(containerId);
              await this.store.purgeBytes(containerId);
              return true;
            },
          );
        });
      } catch (error) {
        const activeTransition = this.authorizationTransitionFence;
        if (
          error instanceof Error &&
          error.name === 'AbortError' &&
          (activeTransition !== null ||
            authorizationGeneration !== this.authorizationGeneration)
        ) {
          await activeTransition;
          continue;
        }
        throw error;
      }
    }
  }

  async purge(
    containerId: string,
    options: {
      authorizationGeneration?: number;
      allowDuringAuthorizationTransition?: boolean;
      allowContainerSnapshotCleanup?: boolean;
      containerSnapshotListingGeneration?: number;
      /** Recipient scope key of the snapshot performing this cleanup. */
      containerSnapshotOrganizationId?: string;
      expectedOrganizationId?: string;
      /** Access paired with `expectedOrganizationId`; absent means organization. */
      expectedAccess?: SharedContainerAccess;
      assertContainerSnapshotIsCurrent?: () => void;
    } = {},
  ): Promise<boolean> {
    const authorizationGeneration =
      options.authorizationGeneration ?? this.authorizationGeneration;
    if (this.purgingAll && this.purgeAllResultPromise) {
      await this.purgeAllResultPromise;
      return true;
    }
    return this.withContainerCleanup(containerId, async () => {
      const running = this.active.get(containerId);
      if (running) {
        if (
          options.expectedOrganizationId === undefined ||
          running.organizationId === options.expectedOrganizationId
        ) {
          running.controller.abort();
        }
        await running.promise.catch(() => undefined);
      }
      return this.withReplicaMutation(
        authorizationGeneration,
        containerId,
        options.expectedOrganizationId !== undefined
          ? sharedContainerRecipientScopeKey(
              options.expectedOrganizationId,
              options.expectedAccess,
            )
          : running
            ? this.activeScopeKey(running)
            : undefined,
        async () => {
          const state = await this.store.get(containerId);
          if (
            options.expectedOrganizationId !== undefined &&
            state?.organizationId !== options.expectedOrganizationId
          ) {
            return false;
          }
          // Remove discoverability first. If byte cleanup is interrupted, the
          // next authoritative integrity pass treats the remaining directory
          // as unindexed and purges it; no cached state can point at missing
          // plaintext in the meantime.
          let cleanupFailed = false;
          let cleanupFailure: unknown;
          try {
            await this.cleanupContainerViewState(containerId);
          } catch (error) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
          await this.store.delete(containerId);
          await this.store.purgeBytes(containerId);
          if (cleanupFailed) {
            throw new SharedContainerReplicaPurgedCleanupError(cleanupFailure);
          }
          return true;
        },
        options,
      );
    });
  }

  async purgeAll(): Promise<void> {
    if (this.purgeAllResultPromise) {
      await this.purgeAllResultPromise;
      return;
    }
    await this.withPurgeAllFence(() => Promise.resolve());
  }

  /**
   * Purge replicas a complete listing no longer authorizes. `scopeKey` is the
   * listing's recipient scope (an organization id, or the direct-share scope
   * key), so an organization listing only reconciles that organization's
   * organization-access replicas, and the direct listing only direct ones.
   */
  async reconcileContainerSnapshot(
    scopeKey: string,
    authorizedContainerIds: readonly string[],
    listingGeneration: number,
    assertSnapshotIsCurrent: () => void = () => undefined,
  ): Promise<void> {
    await this.ensureReplicaStoreIntegrity();
    while (this.containerSnapshotFencePromise) {
      await this.containerSnapshotFencePromise;
    }
    const authorizationGeneration = this.authorizationGeneration;
    const snapshot = {
      scopeKey,
      authorizedContainerIds: new Set(authorizedContainerIds),
    };
    let snapshotInstalled = false;
    const result = (async (): Promise<void> => {
      await this.withAuthorizationMutationLock(() => {
        // The listing may have been superseded while integrity recovery or a
        // prior snapshot fence was in progress. Validate its service-owned
        // generation at the exact boundary where destructive cleanup becomes
        // visible.
        assertSnapshotIsCurrent();
        this.assertContainerSnapshotListingGeneration(
          scopeKey,
          listingGeneration,
        );
        this.assertAuthorizationGeneration(authorizationGeneration);
        if (this.authorizationTransitioning) {
          throw new DOMException(
            'Replica authorization is changing',
            'AbortError',
          );
        }
        this.containerSnapshot = snapshot;
        snapshotInstalled = true;
      });
      const unauthorizedSyncs = Array.from(this.active.entries())
        .filter(
          ([containerId, active]) =>
            this.activeScopeKey(active) === scopeKey &&
            !snapshot.authorizedContainerIds.has(containerId),
        )
        .map(([, active]) => active);
      unauthorizedSyncs.forEach(({ controller }) => controller.abort());
      await Promise.allSettled(unauthorizedSyncs.map(({ promise }) => promise));
      const index = await this.store.readIndex();
      await Promise.all(
        Object.values(index.containers)
          .filter(
            (state) =>
              sharedContainerRecipientScopeKey(
                state.organizationId,
                state.access,
              ) === scopeKey &&
              !snapshot.authorizedContainerIds.has(state.containerId),
          )
          .map(async (state) => {
            let purged: boolean;
            try {
              purged = await this.purge(state.containerId, {
                authorizationGeneration,
                allowContainerSnapshotCleanup: true,
                containerSnapshotListingGeneration: listingGeneration,
                containerSnapshotOrganizationId: scopeKey,
                assertContainerSnapshotIsCurrent: assertSnapshotIsCurrent,
              });
            } catch (error) {
              if (error instanceof SharedContainerReplicaPurgedCleanupError) {
                this.reportSnapshotPurge(state.containerId, scopeKey);
                throw error.cleanupFailure;
              }
              throw error;
            }
            // Mirrors `purgeReplica`'s own `purged !== false` gate: a no-op
            // purge must not claim plaintext was removed.
            if (purged !== false) {
              this.reportSnapshotPurge(state.containerId, scopeKey);
            }
            return purged;
          }),
      );
    })();
    // Waiters loop until the fence is cleared, so it must not settle before
    // it is. Settling with `result` left a settled fence installed while the
    // cleanup below waited for the authorization lock; a waiter then
    // re-awaited it in a microtask loop that starved the lock holder's I/O
    // and pinned the main process.
    let releaseFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    this.containerSnapshotFencePromise = fence;
    try {
      await result;
    } finally {
      try {
        if (snapshotInstalled) {
          await this.withAuthorizationMutationLock(() => {
            if (this.containerSnapshot === snapshot) {
              this.containerSnapshot = null;
            }
          });
        }
      } finally {
        if (this.containerSnapshotFencePromise === fence) {
          this.containerSnapshotFencePromise = null;
        }
        releaseFence();
      }
    }
  }

  async ensureReplicaStoreIntegrity(): Promise<void> {
    try {
      await this.store.readIndexForAuthoritativeCleanup();
    } catch {
      // If the index cannot account for every entry below the bounded replica
      // root, no scoped authorization decision is safe. A full fenced purge is
      // the only fail-closed recovery because unindexed bytes have no reliable
      // organization or container identity.
      await this.purgeAll();
    }
  }

  // Waiters loop on `organizationSnapshotFencePromise` until it is cleared.
  // It settles with `result`, which is safe only because the `finally` below
  // clears it with no `await` first; see `reconcileContainerSnapshot`.
  async withOrganizationSnapshotFence<T>(
    authorizedOrganizationIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    while (this.organizationSnapshotFencePromise) {
      await this.organizationSnapshotFencePromise;
    }
    const authorizedOrganizations = new Set(authorizedOrganizationIds);
    const result = this.withAuthorizationTransition(
      () => {
        this.authorizedOrganizationsDuringSnapshot = authorizedOrganizations;
      },
      async () => {
        const running = Array.from(this.active.values());
        running.forEach(({ controller }) => controller.abort());
        await Promise.allSettled(running.map(({ promise }) => promise));
        return operation();
      },
      () => {
        this.authorizedOrganizationsDuringSnapshot = null;
      },
    );
    const fence = result.then(
      () => undefined,
      () => undefined,
    );
    this.organizationSnapshotFencePromise = fence;
    try {
      return await result;
    } finally {
      if (this.organizationSnapshotFencePromise === fence) {
        this.organizationSnapshotFencePromise = null;
      }
    }
  }

  // Same invariant as `withOrganizationSnapshotFence`: the `finally` must
  // clear `purgeAllPromise` before anything is awaited.
  async withPurgeAllFence<T>(operation: () => Promise<T>): Promise<T> {
    while (this.purgeAllPromise) {
      await this.purgeAllPromise;
    }
    const result = this.withAuthorizationTransition(
      () => {
        this.purgingAll = true;
        this.purgeGeneration += 1;
      },
      async () => {
        await Promise.allSettled(
          Array.from(this.containerPurgePromises.values()),
        );
        const running = Array.from(this.active.values());
        const indexedContainerIds = Object.keys(
          (await this.store.readIndex()).containers,
        );
        const runContainerIds = await readdir(
          getWorktreeDataRootDir(SHARED_CONTAINER_VIEWER_PROJECT_ID),
          { withFileTypes: true },
        )
          .then((entries) =>
            entries
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name),
          )
          .catch(() => [] as string[]);
        const viewStateContainerIds = new Set([
          ...indexedContainerIds,
          ...runContainerIds,
          ...Array.from(this.active.keys()),
          ...Array.from(this.pendingViewStateCleanup),
        ]);
        // Report the authoritative scope BEFORE the bytes go, while the index
        // can still name them. The reconciliation service only knows the
        // containers it was actively tracking, so an accepted share the
        // recipient had closed would lose its plaintext with no diagnostic
        // naming it -- exactly the "a share vanished and nothing says why"
        // case the diagnostic exists for.
        this.reportPurgeAllScope(Array.from(viewStateContainerIds));
        running.forEach(({ controller }) => controller.abort());
        await Promise.allSettled(running.map(({ promise }) => promise));
        const cleanupResults = await Promise.allSettled(
          Array.from(viewStateContainerIds, (containerId) =>
            this.cleanupContainerViewState(containerId),
          ),
        );
        await this.withAuthorizationMutationLock(() =>
          this.store.purgeAllBytes(),
        );
        const cleanupFailure = cleanupResults.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        if (cleanupFailure) throw cleanupFailure.reason;
        return operation();
      },
      () => {
        this.purgingAll = false;
      },
    );
    const fence = result.then(
      () => undefined,
      () => undefined,
    );
    this.purgeAllResultPromise = result;
    this.purgeAllPromise = fence;
    try {
      return await result;
    } finally {
      if (this.purgeAllResultPromise === result) {
        this.purgeAllResultPromise = null;
      }
      if (this.purgeAllPromise === fence) {
        this.purgeAllPromise = null;
      }
    }
  }

  /**
   * Carry the previous revision's checkouts into the new staging tree.
   *
   * `materializeCode` already has an incremental branch that fetches into an
   * existing checkout instead of cloning, but it was unreachable: staging is
   * wiped immediately before materialization and nothing seeded it, so every
   * revision bump paid for a full fresh clone of every repository (CAN-2551).
   *
   * Moving rather than copying is deliberate — the previous revision is pruned
   * once the new one is promoted, and a rename keeps the operation O(1) with no
   * transient duplicate of the checkout on disk. Any failure is swallowed: the
   * clone path remains correct, just slower.
   */
  private async seedStagingRepositories(
    revisionsDir: string,
    stagingDir: string,
    previous: SharedContainerReplicaState | null,
    latestRevisionId: string,
    declaredRepoIds: ReadonlySet<string>,
  ): Promise<SeededCheckouts> {
    const seed: SeededCheckouts = {
      previousReposDir: null,
      checkouts: [],
      mutatedRepoIds: new Set<string>(),
    };
    if (
      (previous?.status !== 'available' && previous?.status !== 'pinned') ||
      previous.revisionId === latestRevisionId
    ) {
      return seed;
    }
    let previousReposDir: string;
    try {
      previousReposDir = join(
        resolveRevisionDirectory(revisionsDir, previous.revisionId),
        'repos',
      );
    } catch {
      return seed;
    }
    let entries: string[];
    try {
      entries = await readdir(previousReposDir);
    } catch {
      return seed;
    }
    // Only repositories the new revision still declares. Seeding used to run
    // before the manifest was downloaded and therefore borrowed every checkout
    // on disk, including ones the publisher had dropped from the share — which
    // were then promoted with the new revision and re-borrowed forever, off the
    // storage budget's books (`repos/` is excluded from it) (CAN-2551).
    const borrowable = entries.filter((entry) => declaredRepoIds.has(entry));
    if (borrowable.length === 0) return seed;
    const stagingReposDir = join(stagingDir, 'repos');
    try {
      // Only the directory itself, so an entry that is never borrowed stays
      // sealed. Renaming a child out requires write+execute on the parent, and
      // this is re-sealed on every exit path below (CAN-2551).
      await chmod(previousReposDir, 0o700);
      seed.previousReposDir = previousReposDir;
      await mkdir(stagingReposDir, { recursive: true });
      // Written before the first move and cleared on every completed exit, so
      // only a crash mid-bump leaves it behind.
      await writeFile(join(previousReposDir, BORROWED_CHECKOUT_MARKER), '');
    } catch {
      await this.resealPreviousRepos(seed);
      return seed;
    }
    for (const entry of borrowable) {
      let source: string;
      let destination: string;
      try {
        // Reuse the same validator the materializer uses, so a directory name
        // that could not have been produced by a legitimate repo id is never
        // carried forward.
        source = resolveMaterializedPath(previousReposDir, entry);
        destination = resolveMaterializedPath(stagingReposDir, entry);
      } catch {
        continue;
      }
      try {
        if (!(await this.isDirectory(join(source, '.git')))) continue;
        // Unseal only the subtree actually being borrowed; materialization
        // needs to write into it.
        await makeReplicaTreeWritable(source);
        await rename(source, destination);
        seed.checkouts.push({
          repoId: entry,
          previousPath: source,
          stagingPath: destination,
        });
      } catch {
        // A cross-device staging root, a concurrent prune, or a permission
        // failure all fall back to the clone path. Re-seal what was unsealed
        // for an entry that never moved.
        await rm(destination, { recursive: true, force: true }).catch(
          () => undefined,
        );
        await this.sealReplicaTree(source).catch(() => undefined);
      }
    }
    if (seed.checkouts.length === 0) await this.resealPreviousRepos(seed);
    return seed;
  }

  /**
   * Re-seal the previous revision's `repos/` directory and forget it.
   *
   * {@link seedStagingRepositories} has to unseal that one directory to rename
   * children out of it. With retention now indefinite (CAN-2551), leaving it
   * writable would mean a decrypted third-party replica keeps a permanently
   * unsealed directory that any other local process could add to or delete
   * from, so every exit path runs through here.
   */
  private async resealPreviousRepos(
    seed: SeededCheckouts,
    options?: { clearMarker?: boolean },
  ): Promise<void> {
    const previousReposDir = seed.previousReposDir;
    if (previousReposDir === null) return;
    seed.previousReposDir = null;
    if (options?.clearMarker !== false) {
      await rm(join(previousReposDir, BORROWED_CHECKOUT_MARKER), {
        force: true,
      }).catch(() => undefined);
    }
    await chmod(previousReposDir, 0o500).catch(() => undefined);
  }

  /**
   * Undo {@link seedStagingRepositories} before staging is discarded.
   *
   * Until the new revision is promoted, the previous revision is still the one
   * replica state points at, so a borrowed checkout must go back or the reader
   * would find an `available` revision whose `repos/` no longer exists. Returns
   * false when a checkout could not be restored, which is the caller's signal
   * that the previous revision can no longer be trusted.
   */
  private async restoreSeededRepositories(
    seed: SeededCheckouts,
  ): Promise<boolean> {
    // A borrowed checkout that materialization already wrote into holds the new
    // revision's content. Restoring it would be worse than losing it: the
    // retained revision would keep an `available` entry and serve file content
    // that contradicts its own layout, with nothing to signal the mismatch.
    //
    // One mutated borrow condemns the whole previous revision — restoring only
    // its untouched siblings would leave a revision whose layout declares a
    // repository that is no longer on disk. But a failure that never reached
    // any borrowed repository (a *new* repository failing to clone, say) leaves
    // every borrow intact and restorable.
    if (seed.checkouts.some((entry) => seed.mutatedRepoIds.has(entry.repoId))) {
      // Keep the breadcrumb: the caller still has to invalidate the index
      // entry, and a crash in that window would otherwise leave a revision
      // claiming `available` with its checkouts gone and nothing on disk left
      // to say so.
      await this.resealPreviousRepos(seed, { clearMarker: false });
      return false;
    }
    let restored = true;
    for (const entry of seed.checkouts) {
      try {
        if (!(await this.isDirectory(entry.stagingPath))) {
          // `checkouts` only holds entries whose rename succeeded, so a missing
          // staging path means the borrowed checkout is gone for good and the
          // previous revision can no longer be served from disk.
          restored = false;
          continue;
        }
        await mkdir(dirname(entry.previousPath), { recursive: true });
        await rm(entry.previousPath, { recursive: true, force: true });
        await rename(entry.stagingPath, entry.previousPath);
        await this.sealReplicaTree(entry.previousPath);
      } catch {
        restored = false;
      }
    }
    // The breadcrumb only comes off when every borrowed checkout is genuinely
    // back. A failed restore leaves it for the next sync's recovery check,
    // which must still fire if the caller's invalidation never lands.
    await this.resealPreviousRepos(seed, { clearMarker: restored });
    return restored;
  }

  /**
   * Drop the index entry for a revision whose checkout could not be put back.
   *
   * Discoverability goes first, exactly as in `close`/`purge`: an entry that
   * cannot be served is worse than no entry, because the next open would read a
   * revision with a missing `repos/` instead of rematerializing it.
   */
  private async invalidateUnrestorableRevision(
    authorizationGeneration: number,
    containerId: string,
    scopeKey: string,
    unrestorableRevisionId: string,
  ): Promise<void> {
    try {
      await this.withReplicaMutation(
        authorizationGeneration,
        containerId,
        scopeKey,
        async (): Promise<void> => {
          // Only the entry that still claims the checkouts we could not put
          // back may be dropped. The blocked-result path writes its state and
          // *then* discards staging, so an unconditional delete here erased a
          // block the caller had already committed and returned — the recipient
          // saw the reason once, then paid a full cold materialize on every
          // later open to re-derive it (CAN-2551).
          const current = await this.store.get(containerId);
          if (current?.status !== 'available' && current?.status !== 'pinned') {
            return;
          }
          if (current.revisionId !== unrestorableRevisionId) return;
          await this.store.delete(containerId);
        },
      );
    } catch {
      // Best effort: integrity recovery repairs the index on the next sync.
    }
  }

  private async performSync(
    containerId: string,
    organizationId: string | undefined,
    requestedAccess: SharedContainerAccess,
    signal: AbortSignal,
    force: boolean,
    authorizationGeneration: number,
    viewerLayoutMode: SharedContainerViewerLayoutMode,
  ): Promise<SharedContainerReplicaState> {
    this.reportPhase(containerId, 'checking-access');
    const detail = await this.transport.resolveLatest(
      containerId,
      organizationId,
      signal,
    );
    if (detail.id !== containerId || detail.organizationId !== organizationId) {
      throw new Error(
        'Shared-container checkpoint does not match the requested container',
      );
    }
    // The server's answer is authoritative for how this recipient reached the
    // container; a server that predates external sharing omits it, which can
    // only mean organization access to an organization-owned container.
    const access = resolveSharedContainerAccess(
      organizationId,
      detail.access === 'direct' || detail.access === 'organization'
        ? detail.access
        : requestedAccess,
    );
    const scopeKey = sharedContainerRecipientScopeKey(organizationId, access);
    // Organization access stays byte-identical to the pre-external-sharing
    // index entry; only direct access is recorded.
    const accessField: { access?: SharedContainerAccess } =
      access === 'direct' ? { access } : {};
    await this.store.prepareContainerForSync(containerId);
    await this.withReplicaMutation(
      authorizationGeneration,
      containerId,
      scopeKey,
      async () => {
        const cached = await this.store.get(containerId);
        if (!cached || cached.organizationId === organizationId) return;
        // A globally unique container id cannot legitimately move between
        // organizations. Once the requested identity has been authenticated,
        // remove every cached byte from the prior identity before considering
        // revision shortcuts or parent-artifact reuse.
        await this.cleanupContainerViewState(containerId);
        await this.store.delete(containerId);
        await this.store.purgeBytes(containerId);
      },
    );
    const now = new Date().toISOString();
    if (!detail.latestRevision) {
      const empty: SharedContainerReplicaState = {
        status: 'nothing-published',
        containerId,
        organizationId,
        ...accessField,
        containerType: detail.containerType,
        updatedAt: now,
      };
      await this.withReplicaMutation(
        authorizationGeneration,
        containerId,
        scopeKey,
        () => this.store.set(empty),
      );
      return empty;
    }
    const latest = detail.latestRevision;
    const latestRevisionId = validateRevisionId(latest.id);
    const revisionsDir = join(
      this.store.containerDir(containerId),
      'revisions',
    );
    const previous = await this.withReplicaMutation(
      authorizationGeneration,
      containerId,
      scopeKey,
      async (): Promise<SharedContainerReplicaState | null> => {
        await this.recoverInterruptedPromotion(
          resolveRevisionDirectory(revisionsDir, latestRevisionId),
          containerId,
        );
        const cached = await this.store.get(containerId);
        if (cached?.status !== 'available' && cached?.status !== 'pinned') {
          return cached;
        }
        let cachedRevisionDir: string;
        try {
          cachedRevisionDir = resolveRevisionDirectory(
            revisionsDir,
            cached.revisionId,
          );
        } catch {
          await this.store.delete(containerId);
          return null;
        }
        if (cached.revisionId !== latestRevisionId) {
          await this.recoverInterruptedPromotion(
            cachedRevisionDir,
            containerId,
          );
        }
        if (!(await this.isDirectory(cachedRevisionDir))) {
          // Repair an index left behind by an interrupted purge before any
          // same-revision or monotonic-revision shortcut can trust it.
          await this.store.delete(containerId);
          return null;
        }
        if (
          await pathExists(
            join(cachedRevisionDir, 'repos', BORROWED_CHECKOUT_MARKER),
          )
        ) {
          // A revision bump was interrupted while this revision's checkouts
          // were on loan to its staging tree, so they may be gone. The
          // directory still exists, which is all the check above proves.
          await this.store.delete(containerId);
          return null;
        }
        return cached;
      },
    );
    if (
      (previous?.status === 'available' || previous?.status === 'pinned') &&
      latest.revision < previous.revision
    ) {
      return previous;
    }
    if (
      !force &&
      (previous?.status === 'available' || previous?.status === 'pinned') &&
      previous.revisionId === latestRevisionId
    ) {
      // A replica materialized by a pre-v5 client has no package field. The
      // authenticated detail belongs to this same immutable revision, so it
      // can fill that field without downloading the encrypted artifacts again.
      let retained: SharedContainerReplicaState = previous;
      if (
        previous.package === undefined &&
        isSharedContainerRevisionPackage(latest.package)
      ) {
        const packageMetadata = latest.package;
        retained = await this.withReplicaMutation(
          authorizationGeneration,
          containerId,
          scopeKey,
          async () => {
            // A pin may have committed after the cached checkpoint was read.
            // Merge under the mutation guard so metadata cannot unpin it or
            // replace a state that now belongs to another revision.
            const current = await this.store.get(containerId);
            if (
              (current?.status !== 'available' &&
                current?.status !== 'pinned') ||
              current.revisionId !== previous.revisionId ||
              current.package !== undefined
            ) {
              return current ?? previous;
            }
            const hydrated = { ...current, package: packageMetadata };
            await this.store.set(hydrated);
            return hydrated;
          },
        );
      }
      await this.refreshViewerBrowsers(containerId).catch(() => undefined);
      // Pruning is post-commit housekeeping: keep the verified revision
      // available if cleanup fails, then retry on the next reconciliation.
      await this.withReplicaMutation(
        authorizationGeneration,
        containerId,
        scopeKey,
        () =>
          this.store
            .pruneRevisions(containerId, previous.revisionId)
            .catch(() => undefined),
      );
      await this.projectViewerChats(containerId, previous.revisionId, {
        mode: viewerLayoutMode,
      });
      return retained;
    }

    const revisionResponse = await this.transport.fetchRevision(
      containerId,
      latestRevisionId,
      organizationId,
      signal,
    );
    const revision = revisionResponse.revision;
    if (
      revision.id !== latestRevisionId ||
      revision.revision !== latest.revision
    ) {
      throw new Error(
        'Shared-container revision detail does not match the resolved checkpoint',
      );
    }
    if (
      revision.schemaVersion > MAX_SUPPORTED_SHARED_CONTAINER_SCHEMA_VERSION
    ) {
      const state: SharedContainerReplicaState = {
        status: 'blocked',
        containerId,
        organizationId,
        ...accessField,
        containerType: detail.containerType,
        reason: 'update-required',
        message: 'A newer app version is required for this share',
        updatedAt: now,
      };
      await this.withReplicaMutation(
        authorizationGeneration,
        containerId,
        scopeKey,
        () => this.store.set(state),
      );
      return state;
    }
    const revisionId = validateRevisionId(revision.id);
    const containerDir = this.store.containerDir(containerId);
    const stagingDir = resolveRevisionDirectory(
      join(containerDir, 'staging'),
      revisionId,
    );
    await makeReplicaTreeWritable(stagingDir);
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(join(stagingDir, '.ciphertext'), { recursive: true });
    this.reportPhase(containerId, 'downloading');
    // Seeding is deferred until the manifest is validated, immediately before
    // materialization (CAN-2551). It *moves* the previous revision's checkouts,
    // so running it here would dismember a revision the index still advertises
    // as `available` for the whole manifest + artifact download — breaking every
    // `repos/`-backed read in an already-open viewer during exactly the
    // publisher-pushed bump the realtime subscription exists for — and would
    // borrow repositories the new revision no longer declares.
    let seededCheckouts: SeededCheckouts = {
      previousReposDir: null,
      checkouts: [],
      mutatedRepoIds: new Set<string>(),
    };
    // The revision the borrowed checkouts belong to, and therefore the only
    // index entry a failed restore may invalidate.
    const borrowedRevisionId =
      previous?.status === 'available' || previous?.status === 'pinned'
        ? previous.revisionId
        : null;
    // Discarding runs at most once. The blocked-result branch discards and then
    // the outer catch may run again; a second pass would find every staging
    // path already renamed back, report `restored = false`, and drop an index
    // entry the first pass had correctly restored (CAN-2551).
    let discarded = false;
    const discardStaging = async (): Promise<void> => {
      if (discarded) return;
      discarded = true;
      if (
        !(await this.restoreSeededRepositories(seededCheckouts)) &&
        borrowedRevisionId !== null
      ) {
        await this.invalidateUnrestorableRevision(
          authorizationGeneration,
          containerId,
          scopeKey,
          borrowedRevisionId,
        );
      }
      // Best effort, like every other cleanup here: the latch above means this
      // runs once, and the next sync wipes `stagingDir` before reusing it
      // anyway, so a transient failure must not mask the error being handled.
      try {
        await makeReplicaTreeWritable(stagingDir);
        await rm(stagingDir, { recursive: true, force: true });
      } catch {
        // Reclaimed by the next sync's staging wipe.
      }
    };
    try {
      const manifestTargets = await this.transport.requestDownloadUrls(
        containerId,
        revisionId,
        organizationId,
        [revisionId],
        signal,
      );
      const manifestTarget = this.onlyTarget(
        manifestTargets.downloads,
        revisionId,
      );
      const manifestCipherPath = join(stagingDir, '.ciphertext', 'manifest');
      if (!/^(?:0|[1-9]\d*)$/.test(revision.artifactSizeBytes)) {
        throw new Error('Shared-container manifest has an invalid size');
      }
      const manifestCiphertextBytes = BigInt(revision.artifactSizeBytes);
      if (
        manifestCiphertextBytes < BigInt(0) ||
        manifestCiphertextBytes >
          ciphertextLengthFor(BigInt(MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES))
      ) {
        throw new Error('Shared-container manifest exceeds the size limit');
      }
      const manifestCipherHash = await this.download(
        manifestTarget.target.url,
        manifestCipherPath,
        signal,
        manifestCiphertextBytes,
      );
      if (manifestCipherHash !== digestHex(revision.artifactHash)) {
        throw new Error(
          'Shared-container manifest ciphertext hash verification failed',
        );
      }
      const cipherStat = await stat(manifestCipherPath);
      if (BigInt(cipherStat.size) !== manifestCiphertextBytes) {
        throw new Error(
          'Shared-container manifest ciphertext size verification failed',
        );
      }
      const manifestPath = join(stagingDir, 'manifest.json');
      await pipeline(
        createReadStream(manifestCipherPath),
        createArtifactDecryptStream(
          decodeKey(manifestTarget.key),
          manifestTarget.key.aad,
        ),
        createWriteStream(manifestPath, { mode: 0o400 }),
      );
      const manifestStat = await stat(manifestPath);
      if (manifestStat.size > MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES) {
        throw new Error('Shared-container manifest exceeds the size limit');
      }
      const manifest = parseManifest(
        JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
      );
      validateArtifactSet(revision, manifest);
      await this.assertStagingWithinReservation(stagingDir);

      const cachedArtifacts = await this.store.getCachedArtifacts(containerId);
      const canReuseParent =
        (previous?.status === 'available' || previous?.status === 'pinned') &&
        manifest.parentRevisionId === previous.revisionId;
      const missingArtifacts: SharedContainerArtifactDetail[] = [];
      for (const artifact of manifest.artifacts) {
        const cached = cachedArtifacts[artifact.artifactId];
        if (
          !canReuseParent ||
          !cached ||
          !(await this.copyCachedArtifact(
            containerDir,
            stagingDir,
            artifact,
            cached,
            signal,
          ))
        ) {
          missingArtifacts.push(artifact);
        }
        await this.assertStagingWithinReservation(stagingDir);
      }
      const artifactTargets =
        missingArtifacts.length > 0
          ? await this.transport.requestDownloadUrls(
              containerId,
              revisionId,
              organizationId,
              missingArtifacts.map((artifact) => artifact.artifactId),
              signal,
            )
          : { downloads: [] };
      const targets = new Map(
        artifactTargets.downloads.map((target) => [target.artifactId, target]),
      );
      if (targets.size !== missingArtifacts.length) {
        throw new Error('Shared-container download targets are incomplete');
      }
      for (const artifact of missingArtifacts) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const target = targets.get(artifact.artifactId);
        if (!target) {
          throw new Error(`Missing download target for ${artifact.artifactId}`);
        }
        await this.downloadAndDecryptArtifact(
          artifact,
          target,
          stagingDir,
          signal,
        );
        await this.assertStagingWithinReservation(stagingDir);
      }
      const layoutValue: unknown = JSON.parse(
        await readFile(join(stagingDir, 'artifacts', 'container.json'), 'utf8'),
      );
      if (!isAnySharedContainerRevisionLayout(layoutValue)) {
        throw new Error('Shared-container container.json is invalid');
      }
      if (layoutValue.containerType !== detail.containerType) {
        throw new Error(
          'Shared-container layout type does not match the grant',
        );
      }
      if (layoutValue.schemaVersion !== revision.schemaVersion) {
        throw new Error(
          'Shared-container layout schema does not match the revision',
        );
      }
      const projectionUsage = validateSharedContainerProjectionBudget(
        layoutValue,
        manifest.artifacts,
      );
      const artifactPathsById = new Map(
        manifest.artifacts.map((artifact) => [
          artifact.artifactId,
          artifact.path,
        ]),
      );
      const artifactSizesById = new Map(
        manifest.artifacts.map((artifact) => [
          artifact.artifactId,
          BigInt(artifact.objectSizeBytes),
        ]),
      );
      await materializeCoworkRevision({
        layout: layoutValue,
        artifactsDir: join(stagingDir, 'artifacts'),
        outputDir: join(stagingDir, 'content'),
        artifactPathsById,
      });
      await this.assertStagingWithinReservation(stagingDir);
      if (layoutValue.containerType === 'CODE_WORKTREE') {
        this.reportPhase(containerId, 'checking-out');
        // Now that the layout is known, borrow the previous revision's
        // checkouts for the repositories this revision still declares, so
        // `materializeCode` finds a `.git` and takes its incremental fetch
        // branch instead of a full clone.
        seededCheckouts = await this.seedStagingRepositories(
          revisionsDir,
          stagingDir,
          previous,
          latestRevisionId,
          new Set(
            layoutValue.repositories.map((repository) => repository.repoId),
          ),
        );
        const codeResult = await this.materializeCode({
          layout: layoutValue,
          artifactsDir: join(stagingDir, 'artifacts'),
          reposDir: join(stagingDir, 'repos'),
          committedRangesDir: join(stagingDir, 'committed-ranges'),
          // A borrowed checkout stops being restorable the moment the
          // materializer writes into it, so the flag is driven by the
          // materializer rather than assumed for the whole call: a failure
          // before any repository is touched still hands the previous
          // revision its checkout back (CAN-2551).
          onRepositoryMutating: (repoId: string): void => {
            seededCheckouts.mutatedRepoIds.add(repoId);
          },
          artifactPathsById,
          artifactSizesById,
          initialProjectionUsage: projectionUsage,
          assertStorageAvailable: () =>
            this.assertStagingWithinReservation(stagingDir),
          signal,
        });
        if (!codeResult.ok) {
          const state: SharedContainerReplicaState = {
            status: 'blocked',
            containerId,
            organizationId,
            ...accessField,
            containerType: detail.containerType,
            reason: codeResult.block.reason,
            message: codeResult.block.message,
            ...(codeResult.block.reason === 'repository-access-missing'
              ? { repository: codeResult.block.repository }
              : {}),
            updatedAt: now,
          };
          await this.withReplicaMutation(
            authorizationGeneration,
            containerId,
            scopeKey,
            () => this.store.set(state),
          );
          await discardStaging();
          return state;
        }
      }
      await this.assertStagingWithinReservation(stagingDir);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const revisionDir = resolveRevisionDirectory(
        join(containerDir, 'revisions'),
        revisionId,
      );
      const state: SharedContainerReplicaState = {
        status: 'available',
        containerId,
        organizationId,
        ...accessField,
        containerType: detail.containerType,
        revisionId,
        revision: revision.revision,
        revisionCreatedAt: revision.createdAt,
        ...(isSharedContainerRevisionPackage(revision.package)
          ? { package: revision.package }
          : {}),
        withheldFileCount: layoutValue.withheldFileCount ?? 0,
        withheldFileReasons: layoutValue.withheldFileReasons ?? [],
        updatedAt: now,
      };
      this.reportPhase(containerId, 'sealing');
      await this.withReplicaMutation(
        authorizationGeneration,
        containerId,
        scopeKey,
        async () => {
          const promotion = await this.promote(
            stagingDir,
            revisionDir,
            containerId,
          );
          try {
            // The promoted tree is not discoverable through replica state until
            // its permissions are sealed. Keeping staging writable until after
            // rename is required on macOS, where renaming a non-writable
            // directory can fail.
            await this.sealReplicaTree(revisionDir);
            await this.store.commitRevision(
              state,
              manifest.artifacts.map((artifact) => ({
                artifactId: artifact.artifactId,
                revisionId,
                path: artifact.path,
                representation: artifact.representation,
                hash: artifact.hash,
                objectSizeBytes: artifact.objectSizeBytes,
              })),
              promotion.promotionId,
            );
          } catch (error) {
            let indexCommitted: boolean;
            try {
              indexCommitted = await this.store.isPromotionCommitted(
                containerId,
                promotion.promotionId,
              );
            } catch (commitCheckError) {
              throw new Error(
                `Shared-container promotion commit state is uncertain after ${error instanceof Error ? error.message : String(error)}: ${commitCheckError instanceof Error ? commitCheckError.message : String(commitCheckError)}`,
              );
            }
            if (!indexCommitted) {
              try {
                await this.rollbackPromotion(revisionDir, promotion);
              } catch (rollbackError) {
                const rollbackMessage =
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError);
                throw new Error(
                  `Shared-container promotion rollback failed: ${rollbackMessage}`,
                );
              }
              throw error;
            }
            // An atomic index rename may have succeeded even if the caller
            // observed a later failure. The durable promotion id makes that
            // commit authoritative, so rollback would restore stale bytes.
          }
          // Once the index commit succeeds, the replacement is authoritative.
          // Backup cleanup is best-effort and pruneRevisions retries it below.
          await this.completePromotion(promotion).catch(() => undefined);
          // File-backed browser views must leave the superseded revision before
          // its sealed directory is removed.
          await this.refreshViewerBrowsers(containerId).catch(() => undefined);
          // The committed revision is already authoritative. Cleanup failure
          // must not roll it back; the same-revision path above retries it.
          await this.store
            .pruneRevisions(containerId, revisionId)
            .catch(() => undefined);
        },
      );
      // `pruneRevisions` normally deletes the previous revision outright, but
      // it is best-effort. Re-seal the directory seeding unsealed so a prune
      // that could not run does not leave a retained replica writable.
      //
      // The breadcrumb deliberately stays: on this path the borrowed checkouts
      // were consumed by the promoted revision, so a directory that survived a
      // failed prune is genuinely incomplete. Nothing indexes it today, but
      // clearing the one marker that says so would make it indistinguishable
      // from a healthy revision if anything ever looked again.
      await this.resealPreviousRepos(seededCheckouts, { clearMarker: false });
      await this.projectViewerChats(containerId, revisionId, {
        mode: viewerLayoutMode,
      });
      return state;
    } catch (error) {
      await discardStaging();
      throw error;
    }
  }

  async pin(
    containerId: string,
    expectedOrganizationId?: string,
  ): Promise<SharedContainerReplicaState | null> {
    const authorizationGeneration = this.authorizationGeneration;
    const generation = this.purgeGeneration;
    const containerGeneration =
      this.containerPurgeGenerations.get(containerId) ?? 0;
    if (this.purgingAll || this.containerPurgePromises.has(containerId)) {
      throw new DOMException('Replica cleanup is in progress', 'AbortError');
    }
    return this.withReplicaMutation(
      authorizationGeneration,
      containerId,
      expectedOrganizationId,
      async () => {
        const state = await this.store.get(containerId);
        if (
          this.purgingAll ||
          generation !== this.purgeGeneration ||
          this.containerPurgePromises.has(containerId) ||
          (state !== null &&
            (this.isOrganizationBlockedDuringSnapshot(
              state.organizationId,
              state.access,
            ) ||
              this.isContainerBlockedDuringSnapshot(
                containerId,
                sharedContainerRecipientScopeKey(
                  state.organizationId,
                  state.access,
                ),
              ))) ||
          containerGeneration !==
            (this.containerPurgeGenerations.get(containerId) ?? 0)
        ) {
          throw new DOMException(
            'Replica cleanup is in progress',
            'AbortError',
          );
        }
        if (
          expectedOrganizationId !== undefined &&
          state?.organizationId !== expectedOrganizationId
        ) {
          return null;
        }
        if (state?.status !== 'available' && state?.status !== 'pinned') {
          return state;
        }
        const pinned: SharedContainerReplicaState = {
          ...state,
          status: 'pinned',
          updatedAt: new Date().toISOString(),
        };
        await this.store.set(pinned);
        return pinned;
      },
    );
  }

  /**
   * Hold the replica mutation lock while a consumer copies one exact revision.
   * Purge, authorization transitions, reconciliation, and promotion therefore
   * cannot replace or remove the source beneath the operation.
   */
  async withReplicaReadGuard<T>(
    containerId: string,
    organizationId: string | undefined,
    revisionId: string,
    operation: (
      revisionRoot: string,
      revision: SharedContainerReplicaRevisionSnapshot,
    ) => Promise<T>,
  ): Promise<T> {
    const authorizationGeneration = this.authorizationGeneration;
    let guardEntered = false;
    return this.withReplicaMutation(
      authorizationGeneration,
      containerId,
      // The snapshot scope depends on the stored access, checked below.
      undefined,
      async () => {
        guardEntered = true;
        const state = await this.store.get(containerId);
        if (
          (state?.status !== 'available' && state?.status !== 'pinned') ||
          state.organizationId !== organizationId
        ) {
          throw new SharedContainerReplicaRevisionUnavailableError(
            'unavailable',
          );
        }
        if (state.revisionId !== revisionId) {
          throw new SharedContainerReplicaRevisionUnavailableError(
            'superseded',
          );
        }
        if (!Number.isFinite(Date.parse(state.revisionCreatedAt))) {
          throw new Error('Invalid shared-container revision publication time');
        }
        if (
          this.isContainerBlockedDuringSnapshot(
            containerId,
            sharedContainerRecipientScopeKey(
              state.organizationId,
              state.access,
            ),
          )
        ) {
          throw new SharedContainerReplicaRevisionUnavailableError(
            'unavailable',
          );
        }
        const revisionRoot = await this.store.resolveRevisionRootForRead(
          containerId,
          revisionId,
        );
        return operation(revisionRoot, {
          revisionId: state.revisionId,
          revisionCreatedAt: state.revisionCreatedAt,
        });
      },
    ).catch((error: unknown) => {
      // Authorization may change while this read waits for the lock. Refuse
      // before effects; never retry or translate an abort from the consumer.
      if (
        !guardEntered &&
        error instanceof DOMException &&
        error.name === 'AbortError'
      ) {
        throw new SharedContainerReplicaRevisionUnavailableError('unavailable');
      }
      throw error;
    });
  }

  private async withAuthorizationMutationLock<T>(
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.authorizationMutationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.authorizationMutationTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withAuthorizationTransition<T>(
    begin: () => void,
    operation: () => Promise<T>,
    end: () => void,
  ): Promise<T> {
    while (this.authorizationTransitionFence) {
      await this.authorizationTransitionFence;
    }
    let releaseFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    this.authorizationTransitionFence = fence;
    await this.withAuthorizationMutationLock(() => {
      this.authorizationTransitioning = true;
      this.authorizationGeneration += 1;
      begin();
    });
    try {
      return await operation();
    } finally {
      await this.withAuthorizationMutationLock(() => {
        end();
        this.authorizationTransitioning = false;
      });
      if (this.authorizationTransitionFence === fence) {
        this.authorizationTransitionFence = null;
      }
      releaseFence();
    }
  }

  /**
   * `scopeKey` is the recipient scope (organization id, or the direct-share
   * scope key) whose in-progress snapshot must not be overtaken.
   */
  private async withReplicaMutation<T>(
    authorizationGeneration: number,
    containerId: string,
    scopeKey: string | undefined,
    operation: () => Promise<T>,
    options: {
      allowDuringAuthorizationTransition?: boolean;
      allowContainerSnapshotCleanup?: boolean;
      containerSnapshotListingGeneration?: number;
      containerSnapshotOrganizationId?: string;
      assertContainerSnapshotIsCurrent?: () => void;
    } = {},
  ): Promise<T> {
    return this.withAuthorizationMutationLock(async () => {
      this.assertAuthorizationGeneration(authorizationGeneration);
      options.assertContainerSnapshotIsCurrent?.();
      if (
        options.containerSnapshotListingGeneration !== undefined &&
        options.containerSnapshotOrganizationId !== undefined
      ) {
        this.assertContainerSnapshotListingGeneration(
          options.containerSnapshotOrganizationId,
          options.containerSnapshotListingGeneration,
        );
      }
      if (
        this.authorizationTransitioning &&
        !options.allowDuringAuthorizationTransition
      ) {
        throw new DOMException(
          'Replica authorization is changing',
          'AbortError',
        );
      }
      if (
        scopeKey &&
        this.isContainerBlockedDuringSnapshot(containerId, scopeKey) &&
        !options.allowContainerSnapshotCleanup
      ) {
        throw new DOMException(
          'Container replica cleanup is in progress',
          'AbortError',
        );
      }
      return operation();
    });
  }

  private assertAuthorizationGeneration(expected: number): void {
    if (expected !== this.authorizationGeneration) {
      throw new DOMException('Replica authorization changed', 'AbortError');
    }
  }

  private assertContainerSnapshotListingGeneration(
    scopeKey: string,
    expected: number,
  ): void {
    if (
      this.currentContainerSnapshotListingGenerations.get(scopeKey) !== expected
    ) {
      throw new DOMException(
        'Shared-container listing was superseded',
        'AbortError',
      );
    }
  }

  /**
   * An organization-membership snapshot only governs organization access.
   * Direct shares (including every personal container) do not depend on the
   * recipient's memberships, so they are never blocked by one.
   */
  private isOrganizationBlockedDuringSnapshot(
    organizationId: string | undefined,
    access: SharedContainerAccess | undefined,
  ): boolean {
    if (
      organizationId === undefined ||
      resolveSharedContainerAccess(organizationId, access) === 'direct'
    ) {
      return false;
    }
    return (
      this.authorizedOrganizationsDuringSnapshot !== null &&
      !this.authorizedOrganizationsDuringSnapshot.has(organizationId)
    );
  }

  private isContainerBlockedDuringSnapshot(
    containerId: string,
    scopeKey: string,
  ): boolean {
    return (
      this.containerSnapshot?.scopeKey === scopeKey &&
      !this.containerSnapshot.authorizedContainerIds.has(containerId)
    );
  }

  private activeScopeKey(active: {
    organizationId?: string;
    access: SharedContainerAccess;
  }): string {
    return sharedContainerRecipientScopeKey(
      active.organizationId,
      active.access,
    );
  }

  private onlyTarget(
    downloads: SharedContainerDownloadTarget[],
    artifactId: string,
  ): SharedContainerDownloadTarget {
    if (downloads.length !== 1 || downloads[0]?.artifactId !== artifactId) {
      throw new Error(`Missing download target for ${artifactId}`);
    }
    return downloads[0];
  }

  private async download(
    url: string,
    destination: string,
    signal: AbortSignal,
    expectedBytes: bigint,
  ): Promise<string> {
    const response = await this.fetchImpl(url, { signal });
    if (!response.ok || !response.body) {
      throw new Error(
        `Shared-container artifact download failed (${response.status})`,
      );
    }
    await mkdir(dirname(destination), { recursive: true });
    const hash = createHash('sha256');
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      boundedHashingTransform(hash, expectedBytes),
      createWriteStream(destination, { mode: 0o600 }),
      { signal },
    );
    return hash.digest('hex');
  }

  private async downloadAndDecryptArtifact(
    artifact: SharedContainerArtifactDetail,
    target: SharedContainerDownloadTarget,
    stagingDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Artifact ids are authenticated metadata, but still owner-controlled. A
    // digest keeps them from ever becoming filesystem path components.
    const cipherFileName = createHash('sha256')
      .update(artifact.artifactId)
      .digest('hex');
    const cipherPath = join(stagingDir, '.ciphertext', cipherFileName);
    const expectedPlaintextSize = BigInt(artifact.objectSizeBytes);
    const expectedCiphertextSize = ciphertextLengthFor(expectedPlaintextSize);
    await this.download(
      target.target.url,
      cipherPath,
      signal,
      expectedCiphertextSize,
    );
    const cipherInfo = await stat(cipherPath);
    if (BigInt(cipherInfo.size) !== expectedCiphertextSize) {
      throw new Error(
        `Ciphertext size verification failed for ${artifact.path}`,
      );
    }
    const destination = join(
      stagingDir,
      'artifacts',
      ...artifact.path.split('/'),
    );
    await mkdir(dirname(destination), { recursive: true });
    const plaintextHash = createHash('sha256');
    let plaintextBytes = 0;
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        plaintextHash.update(chunk);
        plaintextBytes += chunk.byteLength;
        callback(null, chunk);
      },
    });
    await pipeline(
      createReadStream(cipherPath),
      createArtifactDecryptStream(decodeKey(target.key), target.key.aad),
      verifier,
      createWriteStream(destination, { mode: 0o400 }),
      { signal },
    );
    if (
      plaintextBytes !== Number(expectedPlaintextSize) ||
      plaintextHash.digest('hex') !== digestHex(artifact.hash)
    ) {
      throw new Error(
        `Plaintext hash or size verification failed for ${artifact.path}`,
      );
    }
    await chmod(destination, 0o400);
  }

  private async copyCachedArtifact(
    containerDir: string,
    stagingDir: string,
    artifact: SharedContainerArtifactDetail,
    cached: SharedContainerCachedArtifact,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      cached.hash !== artifact.hash ||
      cached.objectSizeBytes !== artifact.objectSizeBytes ||
      cached.representation !== artifact.representation ||
      !ARTIFACT_PATH.test(cached.path)
    ) {
      return false;
    }
    const source = join(
      resolveRevisionDirectory(
        join(containerDir, 'revisions'),
        cached.revisionId,
      ),
      'artifacts',
      ...cached.path.split('/'),
    );
    const destination = join(
      stagingDir,
      'artifacts',
      ...artifact.path.split('/'),
    );
    await mkdir(dirname(destination), { recursive: true });
    const hash = createHash('sha256');
    let bytes = 0;
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        hash.update(chunk);
        bytes += chunk.byteLength;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        createReadStream(source),
        verifier,
        createWriteStream(destination, { mode: 0o400 }),
        { signal },
      );
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (
      bytes !== Number(artifact.objectSizeBytes) ||
      hash.digest('hex') !== digestHex(artifact.hash)
    ) {
      await chmod(destination, 0o600).catch(() => undefined);
      await rm(destination, { force: true });
      return false;
    }
    await chmod(destination, 0o400);
    return true;
  }

  private async promote(
    stagingDir: string,
    revisionDir: string,
    containerId: string,
  ): Promise<PromotedRevision> {
    await mkdir(dirname(revisionDir), { recursive: true });
    await this.recoverInterruptedPromotion(revisionDir, containerId);
    const backupDir = `${revisionDir}.previous`;
    const markerPath = `${revisionDir}.promotion`;
    await makeReplicaTreeWritable(backupDir);
    await rm(backupDir, { recursive: true, force: true });
    const hadPrevious = await this.isDirectory(revisionDir);
    const promotionId = randomUUID();
    const marker: PromotionMarker = {
      version: 2,
      hadPrevious,
      phase: 'prepared',
      containerId,
      promotionId,
    };
    await this.writePromotionMarker(markerPath, marker);
    try {
      if (hadPrevious) await rename(revisionDir, backupDir);
    } catch (error) {
      await rm(markerPath, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await rename(stagingDir, revisionDir);
      return {
        backupDir,
        containerId,
        hadPrevious,
        markerPath,
        promotionId,
      };
    } catch (error) {
      if (hadPrevious) {
        await rename(backupDir, revisionDir).catch(() => undefined);
      }
      await rm(markerPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async rollbackPromotion(
    revisionDir: string,
    promotion: PromotedRevision,
  ): Promise<void> {
    await makeReplicaTreeWritable(revisionDir);
    await rm(revisionDir, { recursive: true, force: true });
    if (promotion.hadPrevious) {
      await rename(promotion.backupDir, revisionDir);
    }
    await rm(promotion.markerPath, { force: true });
  }

  private async completePromotion(promotion: PromotedRevision): Promise<void> {
    // Persist the commit decision before backup cleanup. A restart can then
    // distinguish a verified current tree from a prepared transaction that
    // still needs rollback, regardless of backup permissions.
    await this.writePromotionMarker(promotion.markerPath, {
      version: 2,
      hadPrevious: promotion.hadPrevious,
      phase: 'committed',
      containerId: promotion.containerId,
      promotionId: promotion.promotionId,
    });
    if (promotion.hadPrevious) {
      await makeReplicaTreeWritable(promotion.backupDir);
      await rm(promotion.backupDir, { recursive: true, force: true });
    }
    await rm(promotion.markerPath, { force: true });
  }

  private async recoverInterruptedPromotion(
    revisionDir: string,
    expectedContainerId: string,
  ): Promise<void> {
    const backupDir = `${revisionDir}.previous`;
    const markerPath = `${revisionDir}.promotion`;
    let marker: PromotionMarker | null = null;
    try {
      const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        ((parsed as Partial<PromotionMarker>).version !== 1 &&
          (parsed as Partial<PromotionMarker>).version !== 2) ||
        typeof (parsed as Partial<PromotionMarker>).hadPrevious !== 'boolean' ||
        ((parsed as Partial<PromotionMarker>).phase !== undefined &&
          (parsed as Partial<PromotionMarker>).phase !== 'prepared' &&
          (parsed as Partial<PromotionMarker>).phase !== 'committed')
      ) {
        throw new Error('Shared-container promotion journal is invalid');
      }
      if (
        (parsed as Partial<PromotionMarker>).version === 2 &&
        ((parsed as Partial<PromotionMarker>).containerId !==
          expectedContainerId ||
          (parsed as Partial<PromotionMarker>).phase === undefined ||
          typeof (parsed as Partial<PromotionMarker>).promotionId !==
            'string' ||
          (parsed as Partial<PromotionMarker>).promotionId?.length === 0)
      ) {
        throw new Error('Shared-container promotion journal is invalid');
      }
      marker = {
        version: (parsed as PromotionMarker).version,
        hadPrevious: (parsed as PromotionMarker).hadPrevious,
        // Journals from the immediately preceding implementation did not carry
        // a phase and were always written before promotion.
        phase: (parsed as Partial<PromotionMarker>).phase ?? 'prepared',
        ...((parsed as PromotionMarker).version === 2
          ? {
              containerId: (parsed as PromotionMarker).containerId,
              promotionId: (parsed as PromotionMarker).promotionId,
            }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (marker) {
      const indexCommitted =
        marker.phase === 'prepared' &&
        marker.version === 2 &&
        marker.containerId !== undefined &&
        marker.promotionId !== undefined
          ? await this.store.isPromotionCommitted(
              marker.containerId,
              marker.promotionId,
            )
          : false;
      if (marker.phase === 'committed' || indexCommitted) {
        if (await this.isDirectory(backupDir)) {
          await makeReplicaTreeWritable(backupDir);
          await rm(backupDir, { recursive: true, force: true });
        }
      } else if (marker.hadPrevious && (await this.isDirectory(backupDir))) {
        await makeReplicaTreeWritable(revisionDir);
        await rm(revisionDir, { recursive: true, force: true });
        await rename(backupDir, revisionDir);
        await this.sealReplicaTree(revisionDir);
      } else if (!marker.hadPrevious) {
        await makeReplicaTreeWritable(revisionDir);
        await rm(revisionDir, { recursive: true, force: true });
      }
      await rm(markerPath, { force: true });
      await rm(`${markerPath}.tmp`, { force: true });
      return;
    }

    // Compatibility recovery for an interruption produced before promotion
    // journals existed. Untouched rollback trees are still read-only; cleanup
    // makes their root writable before deleting descendants.
    if (!(await this.isDirectory(backupDir))) return;
    const backupInfo = await lstat(backupDir);
    if ((backupInfo.mode & 0o222) === 0) {
      await makeReplicaTreeWritable(revisionDir);
      await rm(revisionDir, { recursive: true, force: true });
      await rename(backupDir, revisionDir);
      return;
    }
    await makeReplicaTreeWritable(backupDir);
    await rm(backupDir, { recursive: true, force: true });
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await lstat(path)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async writePromotionMarker(
    markerPath: string,
    marker: PromotionMarker,
  ): Promise<void> {
    const temporaryPath = `${markerPath}.tmp`;
    await rm(temporaryPath, { force: true });
    await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, markerPath);
  }
}
