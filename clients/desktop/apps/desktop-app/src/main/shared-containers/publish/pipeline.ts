import { createHash, randomUUID } from 'node:crypto';
import { reportBackgroundFailure } from '../../observability/background-failure-reporter';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline as streamPipeline } from 'node:stream/promises';
import { createArtifactEncryptStream } from '@canopy/artifact-crypto';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import {
  MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES,
  MAX_SHARED_CONTAINER_TITLE_LENGTH,
  SHARED_CONTAINER_STAGE_ALREADY_COMMITTED_ERROR_CODE,
  SHARED_CONTAINER_UPLOAD_TARGET_REFRESH_EXHAUSTED_ERROR_CODE,
  SHARED_CONTAINER_PACKAGE_UPLOAD_EXPIRED_ERROR_CODE,
  isSharedContainerRevisionPackage,
  type SharedContainerRevisionPackage,
  type SharedContainerArtifactDetail,
  type SharedContainerType,
  type SharedContainerStageRevisionRequest,
  type SharedContainerUploadTarget,
} from '@canopy/protocol/shared-containers';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { getSharedContainerPublishStagingRootDir } from '../../lib/paths';
import { isErrnoException } from '../../lib/type-guards';
import { fetchSharedContainerRevision } from '../canopy-server-client';
import type {
  commitSharedContainerRevision,
  stageSharedContainerRevision,
  uploadSharedContainerArtifact,
} from '../canopy-server-client';
import type { readSharedContainerFileScope } from '../file-scope-store';
import {
  getSharedContainerPublicationStateStore,
  type SharedContainerPublicationRecord,
} from '../publication-state';
import { validateRevisionForStage, type RevisionArtifact } from './artifacts';
import { redactAbsolutePaths } from './artifacts';
import { getSharedContainerPublishErrorReason } from './errors';

const CONTENT_FINGERPRINT_ARTIFACT_ID_SEED =
  'shared-container-content-fingerprint-v1';
const PACKAGE_WORK_BUDGET_MS = 10_000;

export type PreparedSharedContainerCapabilityPackage =
  | {
      state: 'ready';
      summary: SharedContainerRevisionPackage;
      /** Upload only after the content/package no-op check. Observe signal. */
      commit(signal: AbortSignal): Promise<{
        capabilityPackage: NonNullable<
          SharedContainerStageRevisionRequest['capabilityPackage']
        >;
        committedPackageUploadId: string;
      }>;
    }
  | { state: 'empty' }
  | { state: 'failed' };

function packageContentFingerprint(
  contentHash: string,
  digest?: string,
): string {
  return digest
    ? sha256(
        Buffer.from(JSON.stringify({ contentHash, packageDigest: digest })),
      )
    : contentHash;
}

async function boundedPackageWork<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let rejectDeadline: (error: Error) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const onAbort = (): void => {
    rejectDeadline(new Error('Shared-container package work aborted'));
  };
  combined.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), PACKAGE_WORK_BUDGET_MS);
  try {
    return await Promise.race([work(combined), deadline]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', onAbort);
  }
}

function canOmitFailedPackage(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 16; depth += 1) {
    if (
      current instanceof CanopyCloudClientError &&
      (current.status === 401 ||
        current.status === 403 ||
        current.status === 409)
    ) {
      return false;
    }
    if (
      !(current instanceof Error) ||
      !('cause' in current) ||
      current.cause === undefined
    )
      return true;
    current = current.cause;
  }
  // An unclassifiable or cyclic cause chain cannot establish a package-only
  // failure. Preserve the refusal rather than swallowing authorization.
  return false;
}

/**
 * Prefix of every staging directory this process creates. Startup recovery
 * prunes only other prefixes: it runs after publication state rehydrates,
 * which can outlast the publish debounce, so a publish may already be staging.
 * Drawn on first use rather than at import, so importing this module has no
 * side effect.
 */
let processStagingDirPrefix: string | undefined;
function getProcessStagingDirPrefix(): string {
  processStagingDirPrefix ??= `revision-${randomUUID()}-`;
  return processStagingDirPrefix;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function rewriteArtifactIds(
  value: unknown,
  ids: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((item) => rewriteArtifactIds(item, ids));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rewriteArtifactIds(item, ids),
      ]),
    );
  }
  return value;
}

function reuseParentArtifactIds(
  artifacts: RevisionArtifact[],
  parentArtifacts: readonly SharedContainerArtifactDetail[],
): Set<string> {
  const parentByPath = new Map(
    parentArtifacts.map((artifact) => [artifact.path, artifact]),
  );
  const replacements = new Map<string, string>();
  for (const artifact of artifacts) {
    if (artifact.path === 'container.json') continue;
    const parent = parentByPath.get(artifact.path);
    if (
      parent?.representation === 'BLOB' &&
      parent.hash === artifact.hash &&
      parent.objectSizeBytes === String(artifact.sizeBytes)
    ) {
      replacements.set(artifact.artifactId, parent.artifactId);
      artifact.artifactId = parent.artifactId;
    }
  }
  const layoutArtifact = artifacts.find(
    (artifact) => artifact.path === 'container.json',
  );
  if (layoutArtifact?.bytes && replacements.size > 0) {
    layoutArtifact.bytes = Buffer.from(
      JSON.stringify(
        rewriteArtifactIds(
          JSON.parse(layoutArtifact.bytes.toString('utf8')),
          replacements,
        ),
      ),
    );
    layoutArtifact.sizeBytes = layoutArtifact.bytes.byteLength;
    layoutArtifact.hash = sha256(layoutArtifact.bytes);
  }
  const carriedIds = new Set<string>();
  for (const artifact of artifacts) {
    const parent = parentByPath.get(artifact.path);
    if (
      parent?.representation === 'BLOB' &&
      parent.hash === artifact.hash &&
      parent.objectSizeBytes === String(artifact.sizeBytes)
    ) {
      artifact.artifactId = parent.artifactId;
      carriedIds.add(parent.artifactId);
    }
  }
  return carriedIds;
}

/**
 * Identity of everything one publish would put on the server, used to skip a
 * republish whose result would be identical.
 *
 * `listTitle` is part of it because it is the plaintext title stored on
 * `shared_containers` and read by recipients before they accept, and no
 * artifact hash covers it — the authenticated title rides inside
 * `container.json`, the plaintext one does not. Leaving it out silently pins
 * recipients to a stale name whenever a title changes without content changing.
 */
function revisionContentFingerprint(
  artifacts: readonly RevisionArtifact[],
  listTitle: string,
): string {
  return sha256(
    Buffer.from(
      JSON.stringify({
        listTitle,
        artifacts: artifacts.map(({ path, sizeBytes, hash }) => ({
          path,
          sizeBytes,
          hash,
        })),
      }),
    ),
  );
}

function isCommittedStageReplay(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    error.serverCode === SHARED_CONTAINER_STAGE_ALREADY_COMMITTED_ERROR_CODE
  );
}

function isUploadTargetRefreshExhausted(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    error.serverCode ===
      SHARED_CONTAINER_UPLOAD_TARGET_REFRESH_EXHAUSTED_ERROR_CODE
  );
}

function canRetryWithoutCarryForward(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    error.code === 'http-error' &&
    (error.status === 400 || error.status === 422)
  );
}

export interface PublishSharedContainerRevisionDependencies<TInventory> {
  signal?: AbortSignal;
  prepareCapabilityPackage?: (input: {
    projectId: string;
    worktreeId: string;
    inventory: TInventory;
    scope: Awaited<ReturnType<typeof readSharedContainerFileScope>>;
    signal: AbortSignal;
  }) => Promise<PreparedSharedContainerCapabilityPackage>;
  buildInventory: (input: {
    projectId: string;
    worktreeId: string;
    scope: Awaited<ReturnType<typeof readSharedContainerFileScope>>;
  }) => Promise<TInventory>;
  buildArtifacts: (
    inventory: TInventory,
    artifactIdSeed: string,
    title: string,
  ) => RevisionArtifact[];
  disposeInventory?: (inventory: TInventory) => Promise<void>;
  resolveTitles?: (input: {
    projectId: string;
    worktreeId: string;
    inventory: TInventory;
  }) => Promise<{ publishedTitle: string; listTitle: string }>;
  beforeStage?: (inventory: TInventory) => Promise<void>;
  validateArtifacts?: typeof validateRevisionForStage;
  readScope: typeof readSharedContainerFileScope;
  stage: typeof stageSharedContainerRevision;
  /**
   * Must finish reading `body` before it settles: the pipeline closes the
   * body as soon as the upload settles.
   */
  upload: typeof uploadSharedContainerArtifact;
  commit: typeof commitSharedContainerRevision;
  fetchRevision?: typeof fetchSharedContainerRevision;
  readDeviceId: () => Promise<string>;
}

export function sanitizeSharedContainerTitle(
  value: string,
  fallback = 'Shared container',
): string {
  const redacted = redactAbsolutePaths(redactSecrets(value)).trim();
  const title = redacted.length > 0 ? redacted : fallback;
  const truncated = title.slice(0, MAX_SHARED_CONTAINER_TITLE_LENGTH);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ? truncated.slice(0, -1)
    : truncated;
}

/**
 * Removes staging owned by any other process, which in practice means an
 * earlier one: the desktop app's single-instance lock keeps a second live
 * publisher off this root.
 */
export async function pruneSharedContainerPublishStaging(): Promise<void> {
  const root = getSharedContainerPublishStagingRootDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => !entry.startsWith(getProcessStagingDirPrefix()))
      .map((entry) => rm(join(root, entry), { recursive: true, force: true })),
  );
}

function stageRequestFingerprint(
  request: SharedContainerStageRevisionRequest,
): string {
  return sha256(Buffer.from(JSON.stringify(request)));
}

function canRestageAfterCommitFailure(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    error.code === 'http-error' &&
    (error.status === 404 || error.status === 409 || error.status === 422)
  );
}

function isMissingStagedRevision(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    error.code === 'http-error' &&
    error.status === 404
  );
}

async function runPublishSharedContainerRevision<TInventory>(
  input: {
    projectId: string;
    worktreeId: string;
    /** Absent for a personal container. */
    organizationId?: string;
    containerId: string;
    containerType: SharedContainerType;
  },
  deps: PublishSharedContainerRevisionDependencies<TInventory>,
): Promise<SharedContainerPublicationRecord> {
  const stateStore = getSharedContainerPublicationStateStore();
  let pendingArtifactContentHash: string | undefined;
  let pendingPackageDigest: string | undefined;
  let pendingCommittedPackageUploadId: string | undefined;
  let pendingCarryParentPackage = false;
  let packageRecoveryPending = false;
  let packageRecoveryAttempts = 0;
  const packagePendingFields =
    (): Partial<SharedContainerPublicationRecord> => ({
      ...(pendingArtifactContentHash ? { pendingArtifactContentHash } : {}),
      ...(pendingPackageDigest ? { pendingPackageDigest } : {}),
      ...(pendingCommittedPackageUploadId
        ? { pendingCommittedPackageUploadId }
        : {}),
      ...(pendingCarryParentPackage ? { pendingCarryParentPackage: true } : {}),
    });
  const assertTargetCurrent = (
    record: SharedContainerPublicationRecord | null,
  ): void => {
    if (record && record.containerId !== input.containerId) {
      throw new Error('Shared-container publication target was superseded');
    }
  };
  const readAndAssertTargetCurrent = async (): Promise<void> => {
    deps.signal?.throwIfAborted();
    assertTargetCurrent(
      await stateStore.get(
        input.projectId,
        input.worktreeId,
        input.organizationId,
      ),
    );
  };
  const setForCurrentTarget = async (
    record: SharedContainerPublicationRecord,
  ): Promise<SharedContainerPublicationRecord> => {
    deps.signal?.throwIfAborted();
    const persisted = await stateStore.set({
      ...record,
      ...(record.status === 'published' ? {} : packagePendingFields()),
    });
    assertTargetCurrent(persisted);
    return persisted;
  };
  const previous = await stateStore.get(
    input.projectId,
    input.worktreeId,
    input.organizationId,
  );
  assertTargetCurrent(previous);
  pendingArtifactContentHash = previous?.pendingArtifactContentHash;
  pendingPackageDigest = previous?.pendingPackageDigest;
  pendingCommittedPackageUploadId = previous?.pendingCommittedPackageUploadId;
  pendingCarryParentPackage = previous?.pendingCarryParentPackage === true;
  packageRecoveryPending = previous?.packageRecoveryPending === true;
  packageRecoveryAttempts = previous?.packageRecoveryAttempts ?? 0;
  let lastCommitted = {
    ...(previous?.revision !== undefined
      ? { revision: previous.revision }
      : {}),
    ...(previous?.revisionId ? { revisionId: previous.revisionId } : {}),
    ...(previous?.publishedAt ? { publishedAt: previous.publishedAt } : {}),
    ...(previous?.publishedContentHash
      ? { publishedContentHash: previous.publishedContentHash }
      : {}),
    ...(previous?.publishedPackageDigest
      ? { publishedPackageDigest: previous.publishedPackageDigest }
      : {}),
  };
  let pendingContentHash = previous?.pendingContentHash;
  const persistCommitted = async (
    committed: Awaited<ReturnType<typeof commitSharedContainerRevision>>,
  ): Promise<SharedContainerPublicationRecord> => {
    const publishedAt = committed.revision.createdAt;
    const publishedPackageDigest = committed.revision.package?.digest;
    if (
      pendingPackageDigest &&
      publishedPackageDigest !== pendingPackageDigest
    ) {
      packageRecoveryPending = true;
      packageRecoveryAttempts = (previous?.packageRecoveryAttempts ?? 0) + 1;
    }
    const actualContentHash = pendingArtifactContentHash
      ? packageContentFingerprint(
          pendingArtifactContentHash,
          publishedPackageDigest,
        )
      : (pendingContentHash ?? previous?.publishedContentHash);
    const record = await setForCurrentTarget({
      ...input,
      status: 'published',
      revision: committed.revision.revision,
      revisionId: committed.revision.id,
      publishedAt,
      updatedAt: publishedAt,
      ...(actualContentHash ? { publishedContentHash: actualContentHash } : {}),
      ...(publishedPackageDigest ? { publishedPackageDigest } : {}),
      ...(packageRecoveryPending
        ? { packageRecoveryPending: true, packageRecoveryAttempts }
        : {}),
    });
    lastCommitted = {
      revision: committed.revision.revision,
      revisionId: committed.revision.id,
      publishedAt,
      ...(actualContentHash ? { publishedContentHash: actualContentHash } : {}),
      ...(publishedPackageDigest ? { publishedPackageDigest } : {}),
    };
    return record;
  };
  const persistFailure = async (
    error: unknown,
    idempotencyKey?: string,
    stagingSessionId?: string,
    stagedRevisionId?: string,
    stageRequestHash?: string,
    restartWithFreshStage = false,
  ): Promise<void> => {
    if (deps.signal?.aborted) return;
    await stateStore.set({
      ...input,
      status: 'error',
      error: error instanceof Error ? error.message : 'Publish failed',
      ...(getSharedContainerPublishErrorReason(error)
        ? { errorReason: getSharedContainerPublishErrorReason(error) }
        : {}),
      updatedAt: new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(stagingSessionId ? { stagingSessionId } : {}),
      ...(stagedRevisionId ? { stagedRevisionId } : {}),
      ...(stageRequestHash ? { stageRequestHash } : {}),
      ...(restartWithFreshStage ? { restartWithFreshStage: true } : {}),
      ...(pendingContentHash ? { pendingContentHash } : {}),
      ...packagePendingFields(),
      ...(packageRecoveryPending
        ? { packageRecoveryPending: true, packageRecoveryAttempts }
        : {}),
      ...lastCommitted,
    });
  };

  let recoveredCommitted: SharedContainerPublicationRecord | undefined;
  if (previous?.stagingSessionId && previous.stagedRevisionId) {
    try {
      recoveredCommitted = await persistCommitted(
        await (deps.fetchRevision ?? fetchSharedContainerRevision)(
          input.containerId,
          previous.stagedRevisionId,
          input.organizationId,
        ),
      );
    } catch (error) {
      if (!isMissingStagedRevision(error)) {
        await persistFailure(
          error,
          previous.idempotencyKey,
          previous.stagingSessionId,
          previous.stagedRevisionId,
          previous.stageRequestHash,
        );
        throw error;
      }
    }
  }

  let scope: Awaited<ReturnType<typeof readSharedContainerFileScope>>;
  let sourceDeviceId: string;
  let inventory: TInventory;
  try {
    [scope, sourceDeviceId] = await Promise.all([
      deps.readScope(input.projectId, input.worktreeId),
      deps.readDeviceId(),
    ]);
    inventory = await deps.buildInventory({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      scope,
    });
  } catch (error) {
    if (recoveredCommitted) return recoveredCommitted;
    throw error;
  }

  const rawTitles = deps.resolveTitles
    ? await deps.resolveTitles({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        inventory,
      })
    : {
        publishedTitle: input.worktreeId,
        listTitle: input.worktreeId,
      };
  const publishedTitle = sanitizeSharedContainerTitle(rawTitles.publishedTitle);
  const listTitle = sanitizeSharedContainerTitle(rawTitles.listTitle);

  const artifactContentHash = revisionContentFingerprint(
    deps.buildArtifacts(
      inventory,
      CONTENT_FINGERPRINT_ARTIFACT_ID_SEED,
      publishedTitle,
    ),
    listTitle,
  );
  let capabilityPackage: PreparedSharedContainerCapabilityPackage = {
    state: 'empty',
  };
  const prepareCapabilityPackage = deps.prepareCapabilityPackage;
  if (prepareCapabilityPackage) {
    try {
      capabilityPackage = await boundedPackageWork(
        (signal) =>
          prepareCapabilityPackage({ ...input, inventory, scope, signal }),
        deps.signal,
      );
      if (
        capabilityPackage.state === 'ready' &&
        !isSharedContainerRevisionPackage(capabilityPackage.summary)
      ) {
        capabilityPackage = { state: 'failed' };
      }
    } catch (error) {
      deps.signal?.throwIfAborted();
      if (!canOmitFailedPackage(error)) throw error;
      capabilityPackage = { state: 'failed' };
    }
    packageRecoveryPending = capabilityPackage.state === 'failed';
    packageRecoveryAttempts = packageRecoveryPending
      ? (previous?.packageRecoveryAttempts ?? 0) + 1
      : 0;
  } else if (packageRecoveryPending) {
    // A missing optional provider is still unavailable work, not a successful
    // empty analysis. Advance the same persisted retry budget after restart.
    capabilityPackage = { state: 'failed' };
    packageRecoveryAttempts = (previous?.packageRecoveryAttempts ?? 0) + 1;
  }
  const candidateDigest =
    capabilityPackage.state === 'ready'
      ? capabilityPackage.summary.digest
      : undefined;
  const contentHash = packageContentFingerprint(
    artifactContentHash,
    candidateDigest,
  );
  const publishedRecord =
    recoveredCommitted ??
    (previous?.status === 'published' ? previous : undefined);
  if (publishedRecord?.publishedContentHash === contentHash) {
    return deps.prepareCapabilityPackage || packageRecoveryPending
      ? setForCurrentTarget({
          ...publishedRecord,
          packageRecoveryPending,
          packageRecoveryAttempts,
        })
      : publishedRecord;
  }
  // The published revision has these exact artifacts, with or without its
  // own package. A package that could not be prepared or attached is no
  // decision to remove that package, so such a publish keeps the revision
  // and leaves recovery pending instead of publishing a degraded one.
  const publishedArtifactsUnchanged =
    publishedRecord?.publishedContentHash !== undefined &&
    publishedRecord.publishedContentHash ===
      packageContentFingerprint(
        artifactContentHash,
        publishedRecord.publishedPackageDigest,
      );
  if (
    publishedRecord &&
    publishedArtifactsUnchanged &&
    capabilityPackage.state === 'failed'
  ) {
    return setForCurrentTarget({
      ...publishedRecord,
      packageRecoveryPending,
      packageRecoveryAttempts,
    });
  }
  pendingArtifactContentHash = artifactContentHash;
  pendingContentHash = contentHash;

  const carryParentRevisionId =
    recoveredCommitted?.revisionId ?? previous?.revisionId;
  const parentRevision =
    carryParentRevisionId && deps.fetchRevision
      ? await deps.fetchRevision(
          input.containerId,
          carryParentRevisionId,
          input.organizationId,
        )
      : undefined;
  const parentArtifacts = parentRevision?.revision.artifacts ?? [];
  const parentPackageDigest = carryParentRevisionId
    ? parentRevision?.revision.package?.digest
    : undefined;
  /**
   * A package that could not be prepared or uploaded is no decision to remove
   * one. A revision with changed artifacts keeps the selected parent's
   * package instead, and recovery stays pending so a later analysis can
   * replace it. Only an `empty` analysis removes a package.
   */
  const carryParentPackageAfterFailure = (): boolean => {
    if (!parentPackageDigest || publishedArtifactsUnchanged) return false;
    pendingPackageDigest = parentPackageDigest;
    pendingCommittedPackageUploadId = undefined;
    pendingCarryParentPackage = true;
    pendingContentHash = packageContentFingerprint(
      artifactContentHash,
      parentPackageDigest,
    );
    return true;
  };
  if (capabilityPackage.state === 'ready') {
    if (pendingPackageDigest !== candidateDigest) {
      pendingCommittedPackageUploadId = undefined;
      pendingCarryParentPackage = false;
    }
    pendingPackageDigest = candidateDigest;
    if (!pendingCommittedPackageUploadId) {
      pendingCarryParentPackage =
        Boolean(carryParentRevisionId) &&
        (parentRevision?.revision.package?.digest === candidateDigest ||
          (pendingCarryParentPackage &&
            previous?.revisionId === carryParentRevisionId));
      if (!pendingCarryParentPackage) {
        try {
          await readAndAssertTargetCurrent();
          const ready = capabilityPackage;
          const uploaded = await boundedPackageWork(
            (signal) => ready.commit(signal),
            deps.signal,
          );
          if (uploaded.capabilityPackage.digest !== candidateDigest) {
            throw new Error('Shared-container prepared package digest changed');
          }
          pendingCommittedPackageUploadId = uploaded.committedPackageUploadId;
        } catch (error) {
          deps.signal?.throwIfAborted();
          if (!canOmitFailedPackage(error)) throw error;
          pendingPackageDigest = undefined;
          packageRecoveryPending = true;
          packageRecoveryAttempts =
            (previous?.packageRecoveryAttempts ?? 0) + 1;
          pendingContentHash = artifactContentHash;
          const carried = carryParentPackageAfterFailure();
          logMainProcessWarn(
            carried
              ? '[shared-containers] capability package upload failed; keeping the parent package'
              : '[shared-containers] capability package upload omitted',
          );
          reportBackgroundFailure(
            'shared-container-publish.package_upload',
            getSharedContainerPublishErrorReason(error) ?? 'unclassified',
          );
        }
      }
    }
  } else {
    pendingPackageDigest = undefined;
    pendingCommittedPackageUploadId = undefined;
    pendingCarryParentPackage = false;
    if (capabilityPackage.state === 'failed') carryParentPackageAfterFailure();
  }

  if (
    !pendingPackageDigest &&
    publishedRecord &&
    (capabilityPackage.state === 'empty'
      ? publishedRecord.publishedContentHash === artifactContentHash
      : publishedArtifactsUnchanged)
  ) {
    return setForCurrentTarget({
      ...publishedRecord,
      packageRecoveryPending,
      packageRecoveryAttempts,
    });
  }

  let idempotencyKey = previous?.idempotencyKey ?? randomUUID();
  const prepareStage = (
    key: string,
    parentRevisionId = carryParentRevisionId,
  ): {
    artifacts: RevisionArtifact[];
    request: SharedContainerStageRevisionRequest;
    fingerprint: string;
  } => {
    const artifacts = deps.buildArtifacts(inventory, key, publishedTitle);
    const carriedIds = reuseParentArtifactIds(artifacts, parentArtifacts);
    const validated = (deps.validateArtifacts ?? validateRevisionForStage)(
      artifacts,
      input.organizationId,
      sourceDeviceId,
      key,
      parentRevisionId,
    );
    const request: SharedContainerStageRevisionRequest = {
      ...validated,
      title: listTitle,
      ...(pendingPackageDigest && pendingCommittedPackageUploadId
        ? {
            capabilityPackage: {
              version: 1 as const,
              digest: pendingPackageDigest,
            },
            committedPackageUploadId: pendingCommittedPackageUploadId,
          }
        : pendingCarryParentPackage
          ? { carryParentPackage: true as const }
          : {}),
      artifacts: validated.artifacts.map((artifact) => ({
        ...artifact,
        ...(carriedIds.has(artifact.artifactId)
          ? { carriedFromParentRevision: true as const }
          : {}),
      })),
    };
    if (
      Buffer.byteLength(JSON.stringify(request)) >
      MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES
    ) {
      throw new Error('Shared-container stage request byte limit exceeded');
    }
    return {
      artifacts,
      request,
      fingerprint: stageRequestFingerprint(request),
    };
  };
  let prepared = prepareStage(idempotencyKey);
  if (recoveredCommitted) {
    if (previous?.stageRequestHash === prepared.fingerprint) {
      return recoveredCommitted;
    }
    idempotencyKey = randomUUID();
    prepared = prepareStage(idempotencyKey, recoveredCommitted.revisionId);
  } else if (
    previous?.stagingSessionId &&
    previous.idempotencyKey === idempotencyKey &&
    previous.stageRequestHash === prepared.fingerprint
  ) {
    try {
      await readAndAssertTargetCurrent();
      return await persistCommitted(
        await deps.commit(
          input.containerId,
          input.organizationId,
          previous.stagingSessionId,
        ),
      );
    } catch (error) {
      if (!canRestageAfterCommitFailure(error)) {
        await persistFailure(
          error,
          previous.idempotencyKey,
          previous.stagingSessionId,
          previous.stagedRevisionId,
          previous.stageRequestHash,
        );
        throw error;
      }
    }
  }
  if (
    !recoveredCommitted &&
    previous?.idempotencyKey &&
    previous.stageRequestHash !== prepared.fingerprint
  ) {
    idempotencyKey = randomUUID();
    prepared = prepareStage(idempotencyKey);
  }
  let { artifacts, request: stageRequest } = prepared;
  let stageRequestHash = prepared.fingerprint;
  await deps.beforeStage?.(inventory);
  let stagedSessionId =
    !recoveredCommitted &&
    previous?.idempotencyKey === idempotencyKey &&
    previous.stageRequestHash === stageRequestHash
      ? previous.stagingSessionId
      : undefined;
  let stagedRevisionId =
    !recoveredCommitted &&
    previous?.idempotencyKey === idempotencyKey &&
    previous.stageRequestHash === stageRequestHash
      ? previous.stagedRevisionId
      : undefined;
  await setForCurrentTarget({
    ...input,
    status: 'publishing',
    updatedAt: new Date().toISOString(),
    idempotencyKey,
    stageRequestHash,
    pendingContentHash,
    ...(stagedSessionId ? { stagingSessionId: stagedSessionId } : {}),
    ...(stagedRevisionId ? { stagedRevisionId } : {}),
    ...lastCommitted,
  });

  await mkdir(getSharedContainerPublishStagingRootDir(), { recursive: true });
  const temporaryDir = await mkdtemp(
    join(
      getSharedContainerPublishStagingRootDir(),
      getProcessStagingDirPrefix(),
    ),
  );
  try {
    let staged: Awaited<ReturnType<typeof stageSharedContainerRevision>>;
    let carriedArtifactIds = new Set(
      stageRequest.artifacts.flatMap((artifact) =>
        artifact.carriedFromParentRevision === true
          ? [artifact.artifactId]
          : [],
      ),
    );
    try {
      await readAndAssertTargetCurrent();
      let retriedArtifactCarry = false;
      let retriedPackageUpload = false;
      for (;;) {
        try {
          await readAndAssertTargetCurrent();
          staged = deps.signal
            ? await deps.stage(input.containerId, stageRequest, deps.signal)
            : await deps.stage(input.containerId, stageRequest);
          break;
        } catch (error) {
          if (
            canRetryWithoutCarryForward(error) &&
            !retriedArtifactCarry &&
            stageRequest.artifacts.some(
              (artifact) => artifact.carriedFromParentRevision === true,
            )
          ) {
            retriedArtifactCarry = true;
            stageRequest = {
              ...stageRequest,
              artifacts: stageRequest.artifacts.map((artifact) => {
                const withoutCarry = { ...artifact };
                delete withoutCarry.carriedFromParentRevision;
                return withoutCarry;
              }),
            };
            stageRequestHash = stageRequestFingerprint(stageRequest);
            carriedArtifactIds.clear();
            continue;
          }
          const packageRefusal =
            error instanceof CanopyCloudClientError &&
            (error.status === 400 ||
              error.status === 422 ||
              error.status === 426);
          if (
            !packageRefusal ||
            (!stageRequest.capabilityPackage &&
              !stageRequest.carryParentPackage)
          ) {
            throw error;
          }
          const ready = capabilityPackage;
          const expired =
            error.serverCode ===
            SHARED_CONTAINER_PACKAGE_UPLOAD_EXPIRED_ERROR_CODE;
          if (
            ready.state === 'ready' &&
            (stageRequest.carryParentPackage ||
              (expired && !retriedPackageUpload))
          ) {
            if (expired) retriedPackageUpload = true;
            try {
              await readAndAssertTargetCurrent();
              const uploaded = await boundedPackageWork(
                (signal) => ready.commit(signal),
                deps.signal,
              );
              if (uploaded.capabilityPackage.digest !== candidateDigest) {
                throw new Error(
                  'Shared-container prepared package digest changed',
                );
              }
              pendingPackageDigest = candidateDigest;
              pendingCommittedPackageUploadId =
                uploaded.committedPackageUploadId;
              pendingCarryParentPackage = false;
            } catch (uploadError) {
              deps.signal?.throwIfAborted();
              if (!canOmitFailedPackage(uploadError)) throw uploadError;
              pendingPackageDigest = undefined;
              pendingCommittedPackageUploadId = undefined;
              pendingCarryParentPackage = false;
              // An expired upload that cannot be replaced still keeps the
              // parent's package; a refused carry is never requested again.
              if (
                !stageRequest.carryParentPackage &&
                carryParentPackageAfterFailure()
              ) {
                packageRecoveryPending = true;
                packageRecoveryAttempts =
                  (previous?.packageRecoveryAttempts ?? 0) + 1;
              }
            }
          } else {
            pendingPackageDigest = undefined;
            pendingCommittedPackageUploadId = undefined;
            pendingCarryParentPackage = false;
          }
          if (!pendingPackageDigest) {
            pendingContentHash = artifactContentHash;
            packageRecoveryPending = true;
            packageRecoveryAttempts =
              (previous?.packageRecoveryAttempts ?? 0) + 1;
            logMainProcessWarn(
              '[shared-containers] capability package stage omitted',
            );
            reportBackgroundFailure(
              'shared-container-publish.package_stage',
              'omitted',
            );
            if (publishedRecord && publishedArtifactsUnchanged) {
              return setForCurrentTarget({
                ...publishedRecord,
                packageRecoveryPending,
                packageRecoveryAttempts,
              });
            }
          }
          // A changed attachment is a new declaration. An ambiguous failure
          // instead keeps the original key and persisted attachment for replay.
          idempotencyKey = randomUUID();
          prepared = prepareStage(idempotencyKey);
          artifacts = prepared.artifacts;
          stageRequest = prepared.request;
          if (retriedArtifactCarry) {
            stageRequest = {
              ...stageRequest,
              artifacts: stageRequest.artifacts.map((artifact) => {
                const withoutCarry = { ...artifact };
                delete withoutCarry.carriedFromParentRevision;
                return withoutCarry;
              }),
            };
          }
          stageRequestHash = stageRequestFingerprint(stageRequest);
          carriedArtifactIds = new Set(
            stageRequest.artifacts.flatMap((artifact) =>
              artifact.carriedFromParentRevision ? [artifact.artifactId] : [],
            ),
          );
          stagedSessionId = undefined;
          stagedRevisionId = undefined;
          await setForCurrentTarget({
            ...input,
            status: 'publishing',
            updatedAt: new Date().toISOString(),
            idempotencyKey,
            stageRequestHash,
            pendingContentHash,
            ...lastCommitted,
          });
        }
      }
    } catch (error) {
      if (!isCommittedStageReplay(error)) throw error;
      stagedSessionId = previous?.stagingSessionId ?? idempotencyKey;
      await readAndAssertTargetCurrent();
      const committed = await deps.commit(
        input.containerId,
        input.organizationId,
        stagedSessionId,
      );
      return persistCommitted(committed);
    }
    stagedSessionId = staged.stagingSessionId;
    stagedRevisionId = staged.revisionId;
    await setForCurrentTarget({
      ...input,
      status: 'publishing',
      updatedAt: new Date().toISOString(),
      idempotencyKey,
      stagingSessionId: staged.stagingSessionId,
      stagedRevisionId: staged.revisionId,
      stageRequestHash,
      pendingContentHash,
      ...lastCommitted,
    });
    const targetsById = new Map(
      staged.uploadTargets.map((target) => [target.artifactId, target]),
    );
    for (const artifact of artifacts) {
      const target: SharedContainerUploadTarget | undefined = targetsById.get(
        artifact.artifactId,
      );
      if (!target) {
        if (carriedArtifactIds.has(artifact.artifactId)) {
          continue;
        }
        throw new Error(
          `Stage response omitted upload target ${artifact.artifactId}`,
        );
      }
      const ciphertextPath = join(temporaryDir, `${artifact.artifactId}.bin`);
      const dataKey = Buffer.from(target.key.dataKey, 'base64');
      const plaintext =
        artifact.source?.createReadStream() ??
        (artifact.bytes ? Readable.from(artifact.bytes) : undefined);
      if (!plaintext) {
        throw new Error('Shared-container artifact content is missing');
      }
      await streamPipeline(
        plaintext,
        createArtifactEncryptStream(
          dataKey,
          target.key.aad,
          artifact.sizeBytes,
        ),
        createWriteStream(ciphertextPath, { flags: 'wx' }),
      );
      const body = createReadStream(ciphertextPath);
      try {
        await deps.upload({
          target,
          body: body as unknown as BodyInit,
          plaintextSizeBytes: artifact.sizeBytes,
          plaintextHash: artifact.hash,
        });
      } finally {
        // An upload can settle without reading the body. Close it before the
        // staging directory is removed; otherwise its lazy open can fail
        // afterwards with an unhandled ENOENT, or hold the file open.
        body.destroy();
        // After destroy() a premature-close rejection is expected; the
        // upload's own outcome is what this attempt reports.
        await finished(body).catch(() => undefined);
      }
    }
    await readAndAssertTargetCurrent();
    const committed = await deps.commit(
      input.containerId,
      input.organizationId,
      staged.stagingSessionId,
    );
    return persistCommitted(committed);
  } catch (error) {
    if (isUploadTargetRefreshExhausted(error)) {
      await persistFailure(
        error,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    } else {
      await persistFailure(
        error,
        idempotencyKey,
        stagedSessionId,
        stagedRevisionId,
        stageRequestHash,
      );
    }
    throw error;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export async function publishSharedContainerRevision<TInventory>(
  input: {
    projectId: string;
    worktreeId: string;
    /** Absent for a personal container. */
    organizationId?: string;
    containerId: string;
    containerType: SharedContainerType;
  },
  deps: PublishSharedContainerRevisionDependencies<TInventory>,
): Promise<SharedContainerPublicationRecord> {
  const disposableSources = new Set<NonNullable<RevisionArtifact['source']>>();
  let builtInventory: TInventory | undefined;
  try {
    return await runPublishSharedContainerRevision(input, {
      ...deps,
      buildInventory: async (inventoryInput) => {
        const inventory = await deps.buildInventory(inventoryInput);
        builtInventory = inventory;
        return inventory;
      },
      buildArtifacts: (inventory, artifactIdSeed, title) => {
        const artifacts = deps.buildArtifacts(inventory, artifactIdSeed, title);
        for (const artifact of artifacts) {
          if (artifact.source?.dispose) disposableSources.add(artifact.source);
        }
        return artifacts;
      },
    });
  } finally {
    const inventoryToDispose = builtInventory;
    const cleanupResults = await Promise.allSettled([
      ...Array.from(disposableSources, (source) => {
        return Promise.resolve().then(() => source.dispose?.());
      }),
      ...(inventoryToDispose !== undefined && deps.disposeInventory
        ? [
            Promise.resolve().then(() =>
              deps.disposeInventory?.(inventoryToDispose),
            ),
          ]
        : []),
    ]);
    for (const result of cleanupResults) {
      if (result.status === 'rejected') {
        logMainProcessWarn('[shared-containers] publish cleanup failed', {
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }
  }
}
