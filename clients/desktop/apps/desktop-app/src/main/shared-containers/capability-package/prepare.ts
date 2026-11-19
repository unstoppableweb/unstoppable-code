/**
 * Production capability-package preparation for shared-container publishing
 * (CAN-4655, plan §5).
 *
 * Preparation analyzes the package of exactly the revision the publisher is
 * building: its included chats come from the publication inventory and, for a
 * code container, the paths its snapshot carries come from the same
 * inventory. Upload is deferred to `commit`, which the publish pipeline calls
 * only after its no-op check, and uploads the analyzed manifest unchanged
 * through the existing capability-package upload path, so the committed
 * digest is the prepared one.
 */
import { randomUUID } from 'node:crypto';
import type { SharedContainerFileScope } from '@canopy/desktop-shared/types';
import type {
  PipelinePackageManifestV1,
  PipelinePackageRef,
} from '@canopy/protocol/pipelines';
import type { SharedContainerStageRevisionRequest } from '@canopy/protocol/shared-containers';
import { readChatTabsFileForIndex } from '../../lib/chat-tabs-reader';
import { listTrackedFiles } from '../../lib/git';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { ShareStageError } from '../../sharing/share-operation-result';
import { isSharedAutomationsWorkflowFormEnabled } from '../../automations/shared-workflow-form-flag';
import type { CodePublishInventory } from '../publish/code-inventory';
import type { CoworkPublishInventory } from '../publish/inventory';
import type { SharedContainerSnapshotPathIndex } from '../publish/capability-usage';
import type { PreparedSharedContainerCapabilityPackage } from '../publish/pipeline';
import {
  analyzeSharedContainerCapabilityPackage,
  type AnalyzeSharedContainerCapabilityPackageInput,
  type CompletedSharedContainerCapabilityPackageAnalysis,
  type ReadySharedContainerCapabilityPackageAnalysis,
  type SharedContainerCapabilityPackageAnalysis,
  type SharedContainerCapabilityPackageContainerType,
} from './analyze';
import {
  getSharedContainerCapabilityPackageAnalysisCache,
  sharedContainerCapabilityPackageInputKey,
  sharedContainerCapabilityPackageScopeKey,
  type SharedContainerCapabilityPackageAnalysisCache,
} from './analysis-cache';

const TRACKED_PATHS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const TRACKED_PATHS_TIMEOUT_MS = 30_000;
/** Matches the preview's background bound. */
const BACKGROUND_ANALYSIS_TIMEOUT_MS = 60_000;

type CommitCapabilityPackageUpload = (
  manifest: PipelinePackageManifestV1,
  readBlob: (sha256: string) => Uint8Array | Promise<Uint8Array>,
  getWindow?: undefined,
  beforeCommit?: () => Promise<void>,
) => Promise<{ uploadId: string; packageRef: PipelinePackageRef }>;

export interface SharedContainerCapabilityPackagePreparationDependencies {
  analyze: (
    input: AnalyzeSharedContainerCapabilityPackageInput,
    options: { previous?: CompletedSharedContainerCapabilityPackageAnalysis },
  ) => Promise<SharedContainerCapabilityPackageAnalysis>;
  cache: SharedContainerCapabilityPackageAnalysisCache;
  readScopeKey: (input: {
    projectId: string;
    worktreeId: string;
    containerType: SharedContainerCapabilityPackageContainerType;
    fileScope: SharedContainerFileScope;
    workflowForm?: boolean;
  }) => Promise<string | undefined>;
  /** The workflow-form flag (CAN-6455), read once per preparation. */
  workflowForm: () => boolean;
  commitUpload: CommitCapabilityPackageUpload;
  isStale: (
    analysis: ReadySharedContainerCapabilityPackageAnalysis,
  ) => Promise<boolean>;
  listTrackedPaths: (repoPath: string) => Promise<string[]>;
  now: () => number;
  /** Bound for an analysis the publication stopped waiting for. */
  backgroundTimeoutMs: number;
}

/** Repository-relative paths in a checkout's index. */
export function listSharedContainerTrackedPaths(
  repoPath: string,
): Promise<string[]> {
  return listTrackedFiles(repoPath, {
    pathspecs: ['.'],
    maxBuffer: TRACKED_PATHS_MAX_BUFFER_BYTES,
    timeoutMs: TRACKED_PATHS_TIMEOUT_MS,
    cachedOnly: true,
  });
}

export async function readSharedContainerCapabilityPackageScopeKey(input: {
  projectId: string;
  worktreeId: string;
  containerType: SharedContainerCapabilityPackageContainerType;
  fileScope: SharedContainerFileScope;
  workflowForm?: boolean;
}): Promise<string | undefined> {
  try {
    return sharedContainerCapabilityPackageScopeKey({
      containerType: input.containerType,
      chatTabs: await readChatTabsFileForIndex(
        input.projectId,
        input.worktreeId,
      ),
      fileScope: input.fileScope,
      ...(input.workflowForm === true ? { workflowForm: true } : {}),
    });
  } catch {
    // Without a scope key the analysis still serves publication; the preview
    // simply cannot claim it matches.
    return undefined;
  }
}

const DEFAULT_DEPENDENCIES: SharedContainerCapabilityPackagePreparationDependencies =
  {
    analyze: (input, options) =>
      analyzeSharedContainerCapabilityPackage(input, undefined, options),
    cache: getSharedContainerCapabilityPackageAnalysisCache(),
    readScopeKey: readSharedContainerCapabilityPackageScopeKey,
    workflowForm: isSharedAutomationsWorkflowFormEnabled,
    commitUpload: async (manifest, readBlob, getWindow, beforeCommit) => {
      const { commitCapabilityPackageUpload } =
        await import('../../pipelines/pipeline-package-service');
      return commitCapabilityPackageUpload(
        manifest,
        readBlob,
        getWindow,
        beforeCommit,
      );
    },
    isStale: async (analysis) => {
      const { pipelinePackageAnalysisIsStale } =
        await import('@canopy/desktop-shared/node');
      return pipelinePackageAnalysisIsStale(analysis.analysis);
    },
    listTrackedPaths: listSharedContainerTrackedPaths,
    now: () => Date.now(),
    backgroundTimeoutMs: BACKGROUND_ANALYSIS_TIMEOUT_MS,
  };

/** An upload failure whose response stays reachable through `cause`. */
class SharedContainerCapabilityPackageUploadError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'SharedContainerCapabilityPackageUploadError';
    this.cause = cause;
  }
}

/**
 * Keeps the cause chain of a wrapped upload failure visible, so the publish
 * pipeline still refuses to swallow an authorization or conflict response.
 */
function exposeUploadFailureCause(error: unknown): unknown {
  return error instanceof ShareStageError
    ? new SharedContainerCapabilityPackageUploadError(
        error.message,
        error.failureCause,
      )
    : error;
}

async function commitReadyAnalysis(
  ready: ReadySharedContainerCapabilityPackageAnalysis,
  signal: AbortSignal,
  deps: SharedContainerCapabilityPackagePreparationDependencies,
): Promise<{
  capabilityPackage: NonNullable<
    SharedContainerStageRevisionRequest['capabilityPackage']
  >;
  committedPackageUploadId: string;
}> {
  signal.throwIfAborted();
  if (await deps.isStale(ready)) {
    throw new Error('Shared-container capability package sources changed');
  }
  signal.throwIfAborted();
  let committed: Awaited<ReturnType<CommitCapabilityPackageUpload>>;
  try {
    committed = await deps.commitUpload(
      ready.manifest,
      (sha256) => {
        // No further blob starts once publication is cancelled.
        signal.throwIfAborted();
        const bytes = ready.analysis.blobs.get(sha256);
        if (!bytes)
          throw new Error('Analyzed capability package blob is missing');
        return bytes;
      },
      undefined,
      () => {
        // Never commit an upload a cancelled publication no longer wants.
        signal.throwIfAborted();
        return Promise.resolve();
      },
    );
  } catch (error) {
    signal.throwIfAborted();
    throw exposeUploadFailureCause(error);
  }
  signal.throwIfAborted();
  if (committed.packageRef.digest !== ready.summary.digest) {
    throw new Error('Shared-container capability package digest changed');
  }
  return {
    capabilityPackage: { version: 1, digest: committed.packageRef.digest },
    committedPackageUploadId: committed.uploadId,
  };
}

export interface PrepareSharedContainerCapabilityPackageInput {
  projectId: string;
  worktreeId: string;
  containerType: SharedContainerCapabilityPackageContainerType;
  includedChatIds: readonly string[];
  snapshotPaths?: SharedContainerSnapshotPathIndex;
  repositories?: AnalyzeSharedContainerCapabilityPackageInput['repositories'];
  fileScope: SharedContainerFileScope;
  signal: AbortSignal;
}

/**
 * Analyzes (or reuses) the package for one revision and returns it with a
 * deferred upload. A completed analysis also refreshes the preview cache.
 *
 * The analysis runs under its own bounded signal. When the publication stops
 * waiting first (its package budget elapsed, or it was cancelled) the
 * analysis may finish in the background, writing only the in-memory cache,
 * so the bounded package recovery that follows can reuse it instead of
 * starting cold again. A retry (or a preview refresh) of the same scope and
 * inputs joins the analysis still running rather than starting another.
 */
export async function prepareSharedContainerCapabilityPackage(
  input: PrepareSharedContainerCapabilityPackageInput,
  deps: SharedContainerCapabilityPackagePreparationDependencies = DEFAULT_DEPENDENCIES,
): Promise<PreparedSharedContainerCapabilityPackage> {
  input.signal.throwIfAborted();
  const target = {
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    containerType: input.containerType,
  };
  // CAN-6455: one reading of the flag decides the keys and the analysis.
  const workflowForm = deps.workflowForm() ? { workflowForm: true } : {};
  // Read before analysis so the key can only be older than what is analyzed.
  const scopeKey = await deps.readScopeKey({
    ...target,
    fileScope: input.fileScope,
    ...workflowForm,
  });
  const analysisInput = {
    ...target,
    includedChatIds: input.includedChatIds,
    ...(input.snapshotPaths ? { snapshotPaths: input.snapshotPaths } : {}),
    ...(input.repositories ? { repositories: input.repositories } : {}),
    ...workflowForm,
  };
  const result = await deps.cache.analyzeShared({
    target,
    // An unreadable scope still caches for publication reuse, but never
    // matches a preview and is never shared.
    scopeKey: scopeKey ?? `unreadable:${randomUUID()}`,
    inputKey: sharedContainerCapabilityPackageInputKey(analysisInput),
    timeoutMs: deps.backgroundTimeoutMs,
    now: deps.now,
    signal: input.signal,
    keepAlive: true,
    analyze: (signal, previous) =>
      deps.analyze({ ...analysisInput, signal }, previous ? { previous } : {}),
  });
  input.signal.throwIfAborted();
  if (result.state === 'failed') {
    logMainProcessWarn(
      '[shared-containers] capability package preparation failed',
      { reason: result.reason },
    );
    return { state: 'failed' };
  }
  if (result.state === 'empty') return { state: 'empty' };
  const ready = result;
  return {
    state: 'ready',
    summary: ready.summary,
    commit: (signal) => commitReadyAnalysis(ready, signal, deps),
  };
}

/**
 * Paths a code revision carries per repository: its base tree with the
 * revision's file changes applied. A snapshot repository's base is the
 * snapshot's own tree. A GitHub repository's recipient clones the pushed
 * base; its changes are the working tree against that base, so the checkout's
 * index stands in for the base tree. Withheld files are in neither.
 */
export async function sharedContainerSnapshotPathsFromCodeInventory(
  inventory: Pick<CodePublishInventory, 'repositories'>,
  signal: AbortSignal,
  listTrackedPaths: SharedContainerCapabilityPackagePreparationDependencies['listTrackedPaths'] = listSharedContainerTrackedPaths,
): Promise<SharedContainerSnapshotPathIndex> {
  const repositories: SharedContainerSnapshotPathIndex['repositories'][number][] =
    [];
  for (const repository of inventory.repositories) {
    signal.throwIfAborted();
    const paths = new Set<string>(
      repository.snapshot
        ? Array.from(repository.snapshot.treeFileSizes.keys())
        : await listTrackedPaths(repository.repoPath),
    );
    signal.throwIfAborted();
    for (const file of repository.files) {
      if (file.status === 'deleted') paths.delete(file.path);
      else paths.add(file.path);
    }
    repositories.push({
      repoId: repository.repoId,
      repoPath: repository.repoPath,
      paths,
    });
  }
  return { repositories };
}

export async function prepareCodeSharedContainerCapabilityPackage(
  input: {
    projectId: string;
    worktreeId: string;
    inventory: CodePublishInventory;
    scope: SharedContainerFileScope;
    signal: AbortSignal;
  },
  deps: SharedContainerCapabilityPackagePreparationDependencies = DEFAULT_DEPENDENCIES,
): Promise<PreparedSharedContainerCapabilityPackage> {
  return prepareSharedContainerCapabilityPackage(
    {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      containerType: 'CODE_WORKTREE',
      includedChatIds: input.inventory.chats.map((chat) => chat.id),
      snapshotPaths: await sharedContainerSnapshotPathsFromCodeInventory(
        input.inventory,
        input.signal,
        deps.listTrackedPaths,
      ),
      repositories: input.inventory.repositories.map((repository) => ({
        repoId: repository.repoId,
        repoPath: repository.repoPath,
      })),
      fileScope: input.scope,
      signal: input.signal,
    },
    deps,
  );
}

export async function prepareCoworkSharedContainerCapabilityPackage(
  input: {
    projectId: string;
    worktreeId: string;
    inventory: CoworkPublishInventory;
    scope: SharedContainerFileScope;
    signal: AbortSignal;
  },
  deps: SharedContainerCapabilityPackagePreparationDependencies = DEFAULT_DEPENDENCIES,
): Promise<PreparedSharedContainerCapabilityPackage> {
  return prepareSharedContainerCapabilityPackage(
    {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      containerType: 'COWORK_WORK_ENTRY',
      includedChatIds: input.inventory.chats.map((chat) => chat.id),
      fileScope: input.scope,
      signal: input.signal,
    },
    deps,
  );
}
