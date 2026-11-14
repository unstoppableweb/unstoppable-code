import { ChatStorageV2 } from './chat-storage-v2';
import {
  captureArchivedWorkspaceRootPayload,
  restoreArchivedWorkspaceRootPayload,
  type ArchivedWorkspaceRepositoryRelocation,
} from './archived-workspace-root-payload';
import { migrateLegacyChatScope } from './legacy-chat-migration';
import {
  ChatStateV2Backend,
  type ChatReadSelection,
} from '../services/chat-state-v2-backend';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  IPC_CHANNELS,
  type ArchivedChatsFile,
  type ArchivedContainerManifest,
  type ArchivedContainerSummary,
  type ArchivedGitState,
  type ChatTabsFile,
  type TrackedPlansFile,
} from '@canopy/desktop-shared/types';
import { isArchivedContainerExpired } from '@canopy/desktop-shared/lib/archive-retention';
import { isArchivedContainerManifest as isArchivedContainerManifestContract } from '@canopy/desktop-shared/lib/archived-container-contracts';
import {
  archivedContainerSummaryWithCost,
  captureEntryCostArchive,
  prepareEntryCostArchive,
  finishEntryCostArchive,
} from '../cost-index/lifecycle';
import { KeyedAsyncLock } from './keyed-async-lock';
import { isPathInside } from './path-safety';
import {
  getArchivedContainerAttachmentsDir,
  getArchivedContainerCostDir,
  getArchivedContainerChatArchivesPath,
  getArchivedContainerChatsPath,
  getArchivedContainerDir,
  getArchivedContainerExecutionsDir,
  getArchivedContainerGitStateStagedPath,
  getArchivedContainerManifestPath,
  getArchivedContainerSummaryPath,
  getArchivedContainerTrackedPlansPath,
  getArchivedContainerWorkspaceRootDir,
  getArchivedContainersRootDir,
  getTrackedPlansFilePath,
  getEntryCostDir,
  getWorktreeAttachmentsDir,
  getWorktreeSummaryFilePath,
  getWorkspaceWorktreeDir,
} from './paths';
import { isErrnoException } from './type-guards';
import { validateId } from './validation';
import { sendToAllWindows } from './window-send';
import { isTrackedPlansFile } from './plan-persistence';
import {
  assertArchivedGitStateManifestIdentity,
  assertArchivedGitStatePurgeable,
  invalidateArchivedContainerChanges,
  discardIncompleteArchivedGitCapture,
  readArchivedGitStagedDescriptor,
  releaseArchivedGitState,
  repinArchivedGitState,
} from './archived-container-git';
import { runArchiveIoRequest } from '../archive/archive-io-runner';
import { isWorkspaceWorktreeCurrent } from './workspace-persistence';
import { hasUnresolvedDestructiveRecovery } from './w5-destructive-recovery';
import { readWorkEntriesFile } from './cowork-work-entries-file';
import { isWorkEntryWorkspace } from './workspace-registry';
import { scheduleDesktopSessionSnapshotInvalidation } from '../services/desktop-session-snapshot-invalidation';

const workspaceMutationLocks = new KeyedAsyncLock();
const archivedWorkspaceOperationLocks = new KeyedAsyncLock();
interface ArchivedWorkspaceOperationLease {
  projectId: string;
  active: boolean;
}
const archivedWorkspaceOperationContext = new AsyncLocalStorage<
  readonly ArchivedWorkspaceOperationLease[]
>();
const containerOperationLocks = new KeyedAsyncLock();

export interface ArchivedContainerCaptureBase {
  projectId: string;
  containerId: string;
  directory: string;
  chats: ChatTabsFile;
  chatArchives: ArchivedChatsFile;
  chatFilePresent: boolean;
  chatArchivesFilePresent: boolean;
}

function isArchivedContainerManifest(
  value: unknown,
): value is ArchivedContainerManifest {
  if (!isArchivedContainerManifestContract(value)) return false;
  try {
    validateId(value.id, 'containerId');
    validateId(value.projectId, 'projectId');
    if (value.version === 2) {
      assertArchivedGitStateManifestIdentity({
        workspaceId: value.projectId,
        containerId: value.id,
        workspaceType: value.workspaceType,
        gitState: value.gitState,
        allowEmptyRepositories: value.restoreScope === 'workspace-root-only',
      });
    }
  } catch {
    return false;
  }
  return true;
}

async function withWorkspaceMutationLock<T>(
  workspaceId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  return workspaceMutationLocks.run(workspaceId, mutate);
}

async function waitForWorkspaceMutation(workspaceId: string): Promise<void> {
  await workspaceMutationLocks.wait(workspaceId);
}

export async function withArchivedContainerOperationLock<T>(
  projectId: string,
  containerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  validateId(projectId, 'projectId');
  validateId(containerId, 'containerId');
  return withArchivedWorkspaceOperationLock(projectId, () =>
    containerOperationLocks.run(`${projectId}:${containerId}`, operation),
  );
}

/** Ownership expires even for async descendants that outlive the operation. */
export function isArchivedWorkspaceOperationLockHeld(
  projectId: string,
): boolean {
  return (archivedWorkspaceOperationContext.getStore() ?? []).some(
    (lease) => lease.active && lease.projectId === projectId,
  );
}

export async function withArchivedWorkspaceOperationLock<T>(
  projectId: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  validateId(projectId, 'projectId');
  signal?.throwIfAborted();
  if (isArchivedWorkspaceOperationLockHeld(projectId)) return operation();
  const inheritedLeases = (
    archivedWorkspaceOperationContext.getStore() ?? []
  ).filter((lease) => lease.active);
  return archivedWorkspaceOperationLocks.run(
    projectId,
    async () => {
      const lease: ArchivedWorkspaceOperationLease = {
        projectId,
        active: true,
      };
      try {
        return await archivedWorkspaceOperationContext.run(
          [...inheritedLeases, lease],
          operation,
        );
      } finally {
        lease.active = false;
      }
    },
    signal,
  );
}

/** Read and validate a JSON file in place; missing or corrupt → null. */
export async function assertArchivedContainerSourceGeneration(
  projectId: string,
  containerId: string,
  expectedCreatedAt: string,
): Promise<void> {
  const current = isWorkEntryWorkspace(projectId)
    ? (await readWorkEntriesFile(projectId)).entries.some(
        (entry) =>
          entry.id === containerId && entry.createdAt === expectedCreatedAt,
      )
    : await isWorkspaceWorktreeCurrent(
        projectId,
        containerId,
        expectedCreatedAt,
      );
  if (!current) {
    throw new Error('Archive source generation changed during capture.');
  }
}

async function resetIncompleteCapture(
  projectId: string,
  containerId: string,
  expectedCreatedAt: string,
): Promise<void> {
  const directory = getArchivedContainerDir(projectId, containerId);
  await runArchiveIoRequest({
    version: 1,
    type: 'reset-directory',
    requestId: randomUUID(),
    operationId: `archive:${projectId}:${containerId}:reset-incomplete-capture`,
    projectId,
    containerId,
    expectedCreatedAt,
    input: {
      path: directory,
      allowedRoot: getArchivedContainersRootDir(projectId),
      preserveNames: [
        basename(getArchivedContainerExecutionsDir(projectId, containerId)),
        basename(
          getArchivedContainerGitStateStagedPath(projectId, containerId),
        ),
        basename(getArchivedContainerWorkspaceRootDir(projectId, containerId)),
        'recovery-files',
        'recovery.staged.json',
        'cost',
      ],
    },
  });
}

export async function restoreArchivedContainerWorkspaceRootFiles(
  projectId: string,
  containerId: string,
  destination: string,
): Promise<ArchivedWorkspaceRepositoryRelocation[]> {
  validateId(projectId, 'projectId');
  validateId(containerId, 'containerId');
  return restoreArchivedWorkspaceRootPayload({
    source: getArchivedContainerWorkspaceRootDir(projectId, containerId),
    destination,
  });
}

/**
 * Stages a capture directory and copies the required chat payloads.
 *
 * A committed manifest for the same container id means a previous delete
 * attempt already archived it and failed later (its live files may already be
 * gone) — that data is preserved and fresh copies merge over it, so retrying
 * a failed delete can never destroy the only surviving transcripts. Without a
 * committed manifest, managed payloads are recreated from scratch while staged
 * executions and workspace-root files are preserved: cleanup may already have
 * removed their live copies before a manifest commit failed.
 */
export async function beginArchivedContainerCapture(
  projectId: string,
  containerId: string,
  options?: {
    captureWorkspaceRootFiles?: boolean;
    managedRepoIds?: readonly string[];
    allowDuringScopeDeletion?: boolean;
    expectedCreatedAt?: string;
  },
): Promise<ArchivedContainerCaptureBase> {
  validateId(projectId, 'projectId');
  validateId(containerId, 'containerId');
  const expectedCreatedAt =
    options?.expectedCreatedAt ?? '1970-01-01T00:00:00.000Z';
  if (options?.expectedCreatedAt) {
    await assertArchivedContainerSourceGeneration(
      projectId,
      containerId,
      options.expectedCreatedAt,
    );
  }
  // Defer the scheduler-backed service until archive capture establishes its
  // deletion fence; listing archived containers does not need this graph.
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  let costPrepared = false;
  try {
    await getAppAdvisorWatcherService().cancelLocalScope(
      projectId,
      containerId,
    );
    // Lazy to break the archived-container/chat-state initialization cycle:
    // chat-state cleanup and archive capture call back into this module.
    const { getChatStateService } =
      await import('../services/chat-state-service');
    await prepareEntryCostArchive(projectId, containerId);
    costPrepared = true;
    // captureStorageScope flushes under the same lease as the copy. A separate
    // pre-flush would reject retries after source deletion, even when a durable
    // capture already holds the complete transcript.
    return await withWorkspaceMutationLock(projectId, async () => {
      const directory = getArchivedContainerDir(projectId, containerId);
      let hasCommittedManifest = true;
      try {
        await readManifestFile(projectId, containerId);
      } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
        hasCommittedManifest = false;
      }
      if (!hasCommittedManifest) {
        await resetIncompleteCapture(projectId, containerId, expectedCreatedAt);
      }
      await mkdir(directory, { recursive: true });

      const captured = archivedChatStorage(projectId, containerId);
      await getChatStateService().captureStorageScope(
        { projectId, worktreeId: containerId },
        captured,
        options?.allowDuringScopeDeletion === true,
        async (source, destination) => {
          await runArchiveIoRequest({
            version: 1,
            type: 'copy-chat-storage',
            requestId: randomUUID(),
            operationId: `archive:${projectId}:${containerId}:copy-chat-storage`,
            projectId,
            containerId,
            expectedCreatedAt,
            input: {
              source: source.descriptor(),
              destination: destination.descriptor(),
            },
          });
        },
      );
      const capturedState = await new ChatStateV2Backend(captured).state();

      const summarySource = getWorktreeSummaryFilePath(projectId, containerId);
      const trackedPlansSource = getTrackedPlansFilePath(
        projectId,
        containerId,
      );
      const attachmentsSource = getWorktreeAttachmentsDir(
        projectId,
        containerId,
      );
      await runArchiveIoRequest({
        version: 1,
        type: 'copy-payload',
        requestId: randomUUID(),
        operationId: `archive:${projectId}:${containerId}:copy-managed-payload`,
        projectId,
        containerId,
        expectedCreatedAt,
        input: {
          sourceRoots: [summarySource, trackedPlansSource, attachmentsSource],
          destinationRoot: directory,
          entries: [
            {
              kind: 'file',
              source: summarySource,
              destination: getArchivedContainerSummaryPath(
                projectId,
                containerId,
              ),
              missingSource: 'ignore',
            },
            {
              kind: 'file',
              source: trackedPlansSource,
              destination: getArchivedContainerTrackedPlansPath(
                projectId,
                containerId,
              ),
              missingSource: 'ignore',
            },
            {
              kind: 'directory',
              source: attachmentsSource,
              destination: getArchivedContainerAttachmentsDir(
                projectId,
                containerId,
              ),
              missingSource: 'ignore',
            },
          ],
        },
      });
      // Cost is optional: its own request, so a failure leaves the archive whole.
      const costSource = getEntryCostDir(projectId, containerId);
      await captureEntryCostArchive(() =>
        runArchiveIoRequest({
          version: 1,
          type: 'copy-payload',
          requestId: randomUUID(),
          operationId: `archive:${projectId}:${containerId}:copy-cost-payload`,
          projectId,
          containerId,
          expectedCreatedAt,
          input: {
            sourceRoots: [costSource],
            destinationRoot: directory,
            entries: [
              {
                kind: 'directory',
                source: costSource,
                destination: getArchivedContainerCostDir(
                  projectId,
                  containerId,
                ),
                missingSource: 'ignore',
              },
            ],
          },
        }),
      );

      if (options?.captureWorkspaceRootFiles) {
        await captureArchivedWorkspaceRootPayload({
          source: getWorkspaceWorktreeDir(projectId, containerId),
          destination: getArchivedContainerWorkspaceRootDir(
            projectId,
            containerId,
          ),
          managedRepoIds: options.managedRepoIds ?? [],
          copyExecutor: async (input) => {
            await runArchiveIoRequest({
              version: 1,
              type: 'copy-payload',
              requestId: randomUUID(),
              operationId: `archive:${projectId}:${containerId}:copy-workspace-root`,
              projectId,
              containerId,
              expectedCreatedAt,
              input,
            });
          },
          removeExecutor: async (input) => {
            await runArchiveIoRequest({
              version: 1,
              type: 'remove-directory',
              requestId: randomUUID(),
              operationId: `archive:${projectId}:${containerId}:remove-workspace-root:${basename(input.path)}`,
              projectId,
              containerId,
              expectedCreatedAt,
              input,
            });
          },
        });
      }

      if (options?.expectedCreatedAt) {
        await assertArchivedContainerSourceGeneration(
          projectId,
          containerId,
          options.expectedCreatedAt,
        );
      }

      return {
        projectId,
        containerId,
        directory,
        chats: capturedState.tabsFile,
        chatArchives: capturedState.archivesFile,
        chatFilePresent: true,
        chatArchivesFilePresent: true,
      };
    });
  } catch (error) {
    await getAppAdvisorWatcherService().releaseLocalScopeFence(
      projectId,
      containerId,
    );
    throw error;
  } finally {
    if (costPrepared) await finishEntryCostArchive(projectId, containerId);
  }
}

export async function countArchivedContainerExecutions(
  projectId: string,
  containerId: string,
): Promise<number> {
  validateId(projectId, 'projectId');
  validateId(containerId, 'containerId');
  let entries: Dirent[];
  try {
    entries = await readdir(
      getArchivedContainerExecutionsDir(projectId, containerId),
      { withFileTypes: true },
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
  return entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith('.json'),
  ).length;
}

/** Atomically publishes a staged capture. This is the archive commit point. */
export async function commitArchivedContainer(
  manifest: ArchivedContainerManifest,
): Promise<void> {
  if (!isArchivedContainerManifest(manifest)) {
    throw new Error('Invalid archived container manifest');
  }
  await withWorkspaceMutationLock(manifest.projectId, async () => {
    const filePath = getArchivedContainerManifestPath(
      manifest.projectId,
      manifest.id,
    );
    const tempPath = join(dirname(filePath), `.container-${randomUUID()}.tmp`);
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(
        tempPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function readManifestFile(
  projectId: string,
  containerId: string,
): Promise<ArchivedContainerManifest> {
  const filePath = getArchivedContainerManifestPath(projectId, containerId);
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (
    !isArchivedContainerManifest(parsed) ||
    parsed.projectId !== projectId ||
    parsed.id !== containerId
  ) {
    throw new Error(`Invalid archived container manifest: ${filePath}`);
  }
  return parsed;
}

export async function readArchivedContainerManifest(
  projectId: string,
  containerId: string,
): Promise<ArchivedContainerManifest> {
  validateId(projectId, 'projectId');
  validateId(containerId, 'containerId');
  await waitForWorkspaceMutation(projectId);
  const manifest = await readManifestFile(projectId, containerId);
  if (isArchivedContainerExpired(manifest, Date.now())) {
    throw new Error(`Archived container ${containerId} was not found`);
  }
  return manifest;
}

/**
 * The manifest even after its retention window has lapsed, for callers acting
 * on an archive that is being removed, or redoing the archive that committed
 * it. Everywhere else an expired archive stays hidden.
 */
export async function readArchivedContainerManifestIncludingExpired(
  projectId: string,
  containerId: string,
): Promise<ArchivedContainerManifest> {
  validateId(projectId, 'projectId');
  validateId(containerId, 'containerId');
  await waitForWorkspaceMutation(projectId);
  return readManifestFile(projectId, containerId);
}

async function safeReadDir(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function listArchivedContainerManifests(
  projectId: string,
): Promise<ArchivedContainerManifest[]> {
  validateId(projectId, 'projectId');
  await waitForWorkspaceMutation(projectId);
  const manifests: ArchivedContainerManifest[] = [];
  for (const entry of await safeReadDir(
    getArchivedContainersRootDir(projectId),
  )) {
    if (!entry.isDirectory()) continue;
    try {
      validateId(entry.name, 'containerId');
      manifests.push(await readManifestFile(projectId, entry.name));
    } catch {
      // A manifest-less/incomplete or corrupt directory is never visible.
    }
  }
  return manifests.sort((left, right) =>
    right.archivedAt.localeCompare(left.archivedAt),
  );
}

/**
 * Enumerates every archive directory as deletion-critical state. Unlike the
 * renderer-facing list, this fails closed when any directory is incomplete,
 * corrupt, or no longer matches its durable identity. `skipping` names
 * directories a caller removes before the deletion reads them (CAN-5337).
 */
export async function listArchivedContainerManifestsStrict(
  projectId: string,
  skipping: ReadonlySet<string> = new Set(),
): Promise<ArchivedContainerManifest[]> {
  validateId(projectId, 'projectId');
  await waitForWorkspaceMutation(projectId);
  const manifests: ArchivedContainerManifest[] = [];
  for (const entry of await safeReadDir(
    getArchivedContainersRootDir(projectId),
  )) {
    if (!entry.isDirectory() || skipping.has(entry.name)) continue;
    validateId(entry.name, 'containerId');
    manifests.push(await readManifestFile(projectId, entry.name));
  }
  return manifests.sort((left, right) =>
    right.archivedAt.localeCompare(left.archivedAt),
  );
}

export async function listArchivedContainers(
  projectId: string,
): Promise<ArchivedContainerSummary[]> {
  // Keep retention enforcement at the storage boundary so direct callers do
  // not accidentally expose expired containers. This unlocked pass only
  // detects expiry: the sweep lists again under the archive operation lock,
  // since a restore may commit `restoredTo` after this read. The dynamic
  // import avoids a module-initialization cycle: the retention sweep itself
  // uses the manifest and purge primitives from this module.
  const now = Date.now();
  const manifests = await listArchivedContainerManifests(projectId);
  const live = manifests.filter(
    (manifest) => !isArchivedContainerExpired(manifest, now),
  );
  if (live.length !== manifests.length) {
    const { purgeExpiredArchivedContainersForWorkspace } =
      await import('./archived-container-retention');
    await purgeExpiredArchivedContainersForWorkspace(projectId, now);
  }
  // Archives that predate disk-usage measurement (or whose post-commit
  // measurement never landed) are measured lazily in the background; the
  // result commits into the manifest and re-broadcasts so the UI fills in.
  // Dynamic import: the measurement module imports this module's commit and
  // lock primitives.
  const needsMeasurement = live.some(
    (manifest) =>
      manifest.diskUsage === undefined ||
      (manifest.version === 2 && manifest.diskUsage.gitBytesComplete !== true),
  );
  if (needsMeasurement) {
    const { scheduleArchivedContainerDiskUsage } =
      await import('./archived-container-disk-usage');
    for (const manifest of live) {
      if (manifest.diskUsage === undefined) {
        scheduleArchivedContainerDiskUsage(projectId, manifest.id);
      } else if (
        manifest.version === 2 &&
        manifest.diskUsage.gitBytesComplete !== true
      ) {
        scheduleArchivedContainerDiskUsage(projectId, manifest.id, {
          retryIncomplete: true,
        });
      }
    }
  }
  return Promise.all(live.map(archivedContainerSummaryWithCost));
}

/**
 * Counts committed containers without parsing manifests — the sidebar calls
 * this for every workspace on each projects load. A directory counts once its
 * `container.json` exists; a corrupt-but-present manifest is still counted
 * here even though `listArchivedContainerManifests` would skip it.
 * Presentation reads may opt out of waiting for captures, accepting a count
 * that changes at commit. Lifecycle/deletion decisions must use the default.
 */
export async function countArchivedContainers(
  projectId: string,
  { waitForMutation = true }: { waitForMutation?: boolean } = {},
): Promise<number> {
  validateId(projectId, 'projectId');
  if (waitForMutation) await waitForWorkspaceMutation(projectId);
  let count = 0;
  for (const entry of await safeReadDir(
    getArchivedContainersRootDir(projectId),
  )) {
    if (!entry.isDirectory()) continue;
    try {
      validateId(entry.name, 'containerId');
      await access(getArchivedContainerManifestPath(projectId, entry.name));
      count += 1;
    } catch {
      // Manifest-less (uncommitted/janitor-pending) directories are invisible.
    }
  }
  return count;
}

function assertContainerPath(
  projectId: string,
  containerId: string,
  targetPath: string,
): string {
  const containerDir = getArchivedContainerDir(projectId, containerId);
  const resolved = resolve(targetPath);
  if (!isPathInside(containerDir, resolved)) {
    throw new Error('Invalid archived container path');
  }
  return resolved;
}

export function resolveArchivedContainerRelativePath(
  projectId: string,
  containerId: string,
  relativePath: string,
): string {
  validateId(projectId, 'projectId');
  validateId(containerId, 'containerId');
  return assertContainerPath(
    projectId,
    containerId,
    join(getArchivedContainerDir(projectId, containerId), relativePath),
  );
}

function archivedChatStorage(
  projectId: string,
  containerId: string,
): ChatStorageV2 {
  return new ChatStorageV2(
    getArchivedContainerDir(projectId, containerId),
    containerId,
    [
      getArchivedContainerChatsPath(projectId, containerId),
      getArchivedContainerChatArchivesPath(projectId, containerId),
      join(
        getArchivedContainerDir(projectId, containerId),
        'chat-journal.jsonl',
      ),
    ],
  );
}

/** Direct upgrade of old archive containers uses the same streaming migration
 * as live scopes. Once selected, v2 is the only archive transcript authority.
 */
export async function getArchivedContainerChatStorage(
  projectId: string,
  containerId: string,
): Promise<ChatStorageV2> {
  // A legacy read writes native storage. Keep it inside the same lifecycle
  // fence as restore/purge so deletion cannot race migration or be followed
  // by a migration recreating the removed container. This lock is reentrant
  // for restore callers that already own the workspace operation.
  return withArchivedWorkspaceOperationLock(projectId, async () => {
    const manifest = await readArchivedContainerManifest(
      projectId,
      containerId,
    );
    if (manifest.restoredTo)
      throw new Error('Archived chat payloads have already been restored');
    const store = archivedChatStorage(projectId, containerId);
    await migrateLegacyChatScope(store, {
      tabs: getArchivedContainerChatsPath(projectId, containerId),
      archives: getArchivedContainerChatArchivesPath(projectId, containerId),
      journal: join(
        getArchivedContainerDir(projectId, containerId),
        'chat-journal.jsonl',
      ),
    });
    return store;
  });
}

/**
 * Read-only membership check for a replay: whether the archive's native
 * storage holds the chat, as a tab or an archived transcript. It reads only
 * the authority manifest and the committed indexes, through the storage's
 * lease-free reader, never through the chat state backend, whose load can
 * resume an interrupted migration and its cleanup. So it writes nothing. An
 * archive without a v2 manifest (legacy storage, or a migration that never
 * published) answers false, and callers fail safe.
 */
export async function archivedContainerHoldsChatReadOnly(
  projectId: string,
  containerId: string,
  chatId: string,
): Promise<boolean> {
  validateId(projectId, 'projectId');
  validateId(containerId, 'containerId');
  const store = archivedChatStorage(projectId, containerId);
  if ((await store.authority()) !== 'v2') return false;
  const indexes = await store.indexes();
  return (
    indexes.live.tabs.some((tab) => tab.id === chatId) ||
    indexes.archive.archived.some((entry) => entry.tab.id === chatId)
  );
}

export async function readArchivedContainerChats(
  projectId: string,
  containerId: string,
  selection: ChatReadSelection = {},
): Promise<ChatTabsFile> {
  const store = await getArchivedContainerChatStorage(projectId, containerId);
  return (await new ChatStateV2Backend(store).state(selection)).tabsFile;
}

export async function readArchivedContainerChatArchives(
  projectId: string,
  containerId: string,
  selection: ChatReadSelection = {},
): Promise<ArchivedChatsFile> {
  const store = await getArchivedContainerChatStorage(projectId, containerId);
  return (await new ChatStateV2Backend(store).state(selection)).archivesFile;
}

/** Missing or corrupt captured plans degrade to an empty file, like live reads. */
export async function readArchivedContainerTrackedPlans(
  projectId: string,
  containerId: string,
): Promise<TrackedPlansFile> {
  await readArchivedContainerManifest(projectId, containerId);
  return readCapturedTrackedPlansFile(projectId, containerId);
}

/**
 * The captured plans file without the manifest gate, for purges that already
 * hold the workspace mutation lock and may run after the archive expired.
 */
async function readCapturedTrackedPlansFile(
  projectId: string,
  containerId: string,
): Promise<TrackedPlansFile> {
  const filePath = getArchivedContainerTrackedPlansPath(projectId, containerId);
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { version: 1, plans: [] };
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    if (isTrackedPlansFile(parsed)) return parsed;
  } catch {
    // Corrupt capture: fall through to the empty file.
  }
  return { version: 1, plans: [] };
}

export function broadcastArchivedContainersChanged(workspaceId: string): void {
  sendToAllWindows(IPC_CHANNELS.archivedContainersChanged, { workspaceId });
  // A retained container's count decides whether a temporary workspace still
  // lists; the shared rail reads that from the session snapshot.
  scheduleDesktopSessionSnapshotInvalidation();
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Locks or unlocks a committed container. Locking stamps `lockedAt` so the
 * retention sweep skips it; unlocking clears the stamp and restarts the full
 * `retentionDays` window from the unlock time (never the original archive
 * time). Expired-but-unlocked containers are invisible everywhere else, so
 * they cannot be locked either.
 */
export async function setArchivedContainerLocked(
  projectId: string,
  containerId: string,
  locked: boolean,
  now = Date.now(),
): Promise<ArchivedContainerSummary> {
  return withArchivedContainerOperationLock(
    projectId,
    containerId,
    async () => {
      const manifest = await readArchivedContainerManifest(
        projectId,
        containerId,
      );
      if (locked === (manifest.lockedAt !== undefined)) {
        return archivedContainerSummaryWithCost(manifest);
      }
      let updated: ArchivedContainerManifest;
      if (locked) {
        updated = { ...manifest, lockedAt: new Date(now).toISOString() };
      } else {
        const { lockedAt: _lockedAt, ...unlocked } = manifest;
        void _lockedAt;
        updated = {
          ...unlocked,
          expiresAt: new Date(
            now + manifest.retentionDays * DAY_MS,
          ).toISOString(),
        };
      }
      await commitArchivedContainer(updated);
      // Break the archived-container ↔ chat-search initialization cycle; the
      // search service imports archive enumeration during startup.
      const { getChatSearchService } = await import('../chat-search/service');
      getChatSearchService().archivedContainerUpdated(projectId, containerId);
      broadcastArchivedContainersChanged(projectId);
      return archivedContainerSummaryWithCost(updated);
    },
  );
}

/**
 * CAN-5338: a user-confirmed discard of a retained archive whose permanent
 * deletion cannot finish. The abandoned Git validation is skipped and refs are
 * released best effort, never re-pinned; everything else is the ordinary
 * purge's. Reached only through {@link purgeArchivedContainerForDiscard}.
 */
interface ArchivedContainerDiscardPurge {
  /** The container directory's stat identity the user confirmed. */
  readonly expectedIdentity: { dev: number; ino: number; birthtimeMs: number };
  /** Releases what it can and never throws. */
  readonly releaseGitState: (gitState: ArchivedGitState) => Promise<void>;
}

async function purgeArchivedContainerWithoutOperationLock(
  projectId: string,
  containerId: string,
  options?: {
    onlyIfDeleted?: boolean;
    preserveLegacyChats?: boolean;
    discard?: ArchivedContainerDiscardPurge;
  },
): Promise<boolean> {
  const discard = options?.discard;
  const directory = getArchivedContainerDir(projectId, containerId);
  let manifest: ArchivedContainerManifest;
  try {
    manifest = await readManifestFile(projectId, containerId);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
  if (options?.onlyIfDeleted === true && manifest.lockedAt !== undefined) {
    return false;
  }
  let stagedGitState: ArchivedGitState | null = null;
  if (manifest.version === 3) {
    if (manifest.recovery.gitCleanupPending) {
      // Intentional local import breaks the archive/recovery initialization
      // cycle; build:e2e verifies this module resolves in packaged bytecode.
      const { finishArchivedContainerRecovery } =
        await import('./archived-container-recovery');
      await finishArchivedContainerRecovery(manifest, {
        discardingArchive: true,
        ...(discard ? { abandonVerification: true } : {}),
      });
      await commitArchivedContainer(manifest);
      if (manifest.recovery.gitCleanupPending && !discard) {
        throw new Error(
          'Git registration cleanup is still pending. Retry after the source repository is available.',
        );
      }
    }
    const staged = await readArchivedGitStagedDescriptor(
      projectId,
      containerId,
      discard ? { readOnly: true, recoveryOnly: true } : undefined,
    );
    if (staged && staged.repositories.length > 0) {
      stagedGitState = {
        version: 1,
        diffFormatVersion: 1,
        repositories: staged.repositories,
      };
      if (!discard)
        await assertArchivedGitStatePurgeable({
          projectId,
          id: containerId,
          workspaceType: manifest.workspaceType,
          gitState: stagedGitState,
        });
    }
  }
  if (manifest.version === 2 && !discard) {
    // The manifest is the durable identity record for retained refs. If it
    // cannot be verified, preserve both the archive and refs for recovery.
    await assertArchivedGitStatePurgeable(manifest);
  }
  // Archived-changes reads wait for the workspace mutation lock. Drain and
  // hold them before acquiring that lock so purge cannot deadlock with a read.
  const resumeArchivedChanges = await invalidateArchivedContainerChanges(
    projectId,
    containerId,
    { hold: true },
  );
  try {
    return await withWorkspaceMutationLock(projectId, async () => {
      let directoryRemovalStarted = false;
      try {
        const gitState =
          manifest.version === 2 ? manifest.gitState : stagedGitState;
        if (gitState) {
          await (discard
            ? discard.releaseGitState(gitState)
            : releaseArchivedGitState(gitState));
        } else {
          const discarded = await discardIncompleteArchivedGitCapture(
            projectId,
            containerId,
            { allowMissingWorktree: true },
          );
          if (!discarded) {
            throw new Error(
              'An incomplete archived Git capture requires recovery.',
            );
          }
        }
        // Keep the existing search-index ordering contract: purge documents
        // while the committed container is still readable, then remove it.
        const { getChatSearchService } = await import('../chat-search/service');
        try {
          await getChatSearchService().worktreeContainerPurged(
            projectId,
            containerId,
          );
        } catch (error) {
          // The archive is canonical and the search index is rebuildable. A
          // worker shutdown or saturated derived-index queue must not abort the
          // durable purge or cause released Git refs to be re-pinned.
          // eslint-disable-next-line no-console
          console.error('Failed to remove archived chat search rows:', error);
        }
        if (
          manifest.kind === 'worktree' &&
          options?.preserveLegacyChats !== true
        ) {
          // Deferred to keep archive enumeration free of review-chat service
          // initialization; packaged build coverage verifies this chunk.
          const { removeCodeReviewChatsForWorktree } =
            await import('./code-review-cleanup');
          const warnings = await removeCodeReviewChatsForWorktree(
            projectId,
            manifest.id,
          );
          if (warnings.length) throw new Error(warnings.join('\n'));
        }
        if (
          manifest.kind === 'worktree' &&
          options?.preserveLegacyChats !== true &&
          manifest.restoredTo !== undefined
        ) {
          // A restored archive's legacy plan chats belong to the restored
          // worktree. Restore commits `restoredTo` before it moves their
          // registry rows, so finish that (owner-checked, idempotent) move
          // instead of reclaiming them; a failure keeps the archive.
          const { transferPlanExploreTargets } =
            await import('./plan-explore-registry');
          await transferPlanExploreTargets(
            { projectId, worktreeId: manifest.id },
            { projectId, worktreeId: manifest.restoredTo.id },
          );
        }
        if (
          manifest.kind === 'worktree' &&
          options?.preserveLegacyChats !== true &&
          manifest.restoredTo === undefined
        ) {
          // Archiving kept the worktree's legacy plan chats; reclaim them from
          // the captured plan ids (plus the registry sweep). Deferred like the
          // review cleanup: it pulls in live session teardown.
          const planIds = (
            await readCapturedTrackedPlansFile(projectId, containerId)
          ).plans.map((plan) => plan.id);
          const { removePlanExploreChatsForWorktree } =
            await import('./plan-explore-cleanup');
          const planWarnings = await removePlanExploreChatsForWorktree(
            projectId,
            manifest.id,
            planIds,
          );
          if (planWarnings.length) throw new Error(planWarnings.join('\n'));
        }
        directoryRemovalStarted = true;
        if (discard) {
          // The confirmed directory only. The manifest goes last, so a crash
          // leaves an archive that still lists, and a retry finishes it.
          const current = await lstat(directory);
          if (
            !current.isDirectory() ||
            current.dev !== discard.expectedIdentity.dev ||
            current.ino !== discard.expectedIdentity.ino ||
            current.birthtimeMs !== discard.expectedIdentity.birthtimeMs
          )
            throw new Error(
              'The archived worktree changed identity; it was preserved.',
            );
          await runArchiveIoRequest({
            version: 1,
            type: 'reset-directory',
            requestId: randomUUID(),
            operationId: `archive:${projectId}:${containerId}:discard-contents`,
            projectId,
            containerId,
            expectedCreatedAt: manifest.createdAt,
            input: {
              path: directory,
              allowedRoot: getArchivedContainersRootDir(projectId),
              preserveNames: ['container.json'],
            },
          });
        }
        await runArchiveIoRequest({
          version: 1,
          type: 'remove-directory',
          requestId: randomUUID(),
          operationId: `archive:${projectId}:${containerId}:purge-directory`,
          projectId,
          containerId,
          expectedCreatedAt: manifest.createdAt,
          input: {
            path: directory,
            allowedRoot: getArchivedContainersRootDir(projectId),
          },
        });
      } catch (error) {
        const archiveStillExists = directoryRemovalStarted
          ? await access(directory)
              .then(() => true)
              .catch((accessError: unknown) => {
                if (
                  isErrnoException(accessError) &&
                  accessError.code === 'ENOENT'
                ) {
                  return false;
                }
                return true;
              })
          : true;
        const gitStateToRepin =
          manifest.version === 2 ? manifest.gitState : stagedGitState;
        // A discard never re-pins: its abandoned refs may name a gone source.
        if (gitStateToRepin && archiveStillExists && !discard) {
          await repinArchivedGitState(gitStateToRepin).catch((repinError) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to re-pin archived Git refs after purge failed.',
              repinError,
            );
          });
        }
        if (archiveStillExists) throw error;
      }
      broadcastArchivedContainersChanged(projectId);
      return true;
    });
  } finally {
    resumeArchivedChanges();
  }
}

export async function purgeArchivedContainer(
  projectId: string,
  containerId: string,
  options?: { onlyIfDeleted?: boolean },
): Promise<boolean> {
  return withArchivedContainerOperationLock(projectId, containerId, () =>
    purgeArchivedContainerWithoutOperationLock(projectId, containerId, options),
  );
}

/**
 * CAN-5338: the retained archive discard's purge, for a caller that already
 * holds the container operation lock. Only `retained-archive-discard.ts` may
 * import it (see the import-boundary test): the retention sweep, restore and
 * Auto Delete keep the ordinary purge and its Git validation.
 */
export async function purgeArchivedContainerForDiscard(
  projectId: string,
  containerId: string,
  discard: ArchivedContainerDiscardPurge,
): Promise<boolean> {
  return purgeArchivedContainerWithoutOperationLock(projectId, containerId, {
    discard,
  });
}

/** Called only by restore while it already owns the container operation lock. */
export async function purgeArchivedContainerAfterRestore(
  projectId: string,
  containerId: string,
): Promise<boolean> {
  return purgeArchivedContainerWithoutOperationLock(projectId, containerId, {
    preserveLegacyChats: true,
  });
}

export async function removeIncompleteArchivedContainers(
  projectId: string,
  olderThanMs: number,
  now = Date.now(),
): Promise<number> {
  validateId(projectId, 'projectId');
  return withWorkspaceMutationLock(projectId, async () => {
    let removed = 0;
    for (const entry of await safeReadDir(
      getArchivedContainersRootDir(projectId),
    )) {
      if (!entry.isDirectory()) continue;
      try {
        validateId(entry.name, 'containerId');
      } catch {
        continue;
      }
      const manifestPath = getArchivedContainerManifestPath(
        projectId,
        entry.name,
      );
      const manifestInfo = await stat(manifestPath).catch((error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') return null;
        throw error;
      });
      // The janitor owns only disposable manifest-less staging directories. A
      // corrupt committed manifest is hidden from listings but preserved for
      // manual recovery. Likewise, staged executions or workspace-root files
      // may be the only surviving copies after cleanup succeeded but the
      // manifest commit failed.
      if (manifestInfo) continue;
      const directory = getArchivedContainerDir(projectId, entry.name);
      // A failed copy or publication can leave the only remaining checkout
      // bytes here. Neither a missing manifest nor age makes them disposable.
      if (
        (await safeReadDir(join(directory, 'recovery-files'))).length > 0 ||
        (await stat(join(directory, 'recovery.staged.json')).catch(
          (error: unknown) => {
            if (isErrnoException(error) && error.code === 'ENOENT') return null;
            throw error;
          },
        ))
      )
        continue;
      if (
        (
          await safeReadDir(
            getArchivedContainerExecutionsDir(projectId, entry.name),
          )
        ).length > 0 ||
        (
          await safeReadDir(
            getArchivedContainerWorkspaceRootDir(projectId, entry.name),
          )
        ).length > 0
      ) {
        continue;
      }
      const info = await stat(directory).catch(() => null);
      if (!info || now - info.mtimeMs < olderThanMs) continue;
      if (await hasUnresolvedDestructiveRecovery(projectId, entry.name)) {
        continue;
      }
      const stagedGitState = await readFile(
        getArchivedContainerGitStateStagedPath(projectId, entry.name),
        'utf8',
      ).catch((error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') return null;
        throw error;
      });
      if (stagedGitState !== null) {
        let mayRemove = false;
        try {
          mayRemove = await discardIncompleteArchivedGitCapture(
            projectId,
            entry.name,
          );
        } catch {
          // Invalid, ready, or teardown-bearing state is recovery material.
          mayRemove = false;
        }
        if (!mayRemove) continue;
      }
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  });
}

export async function removeArchivedContainerPayloadsAfterPartialRestore(
  projectId: string,
  containerId: string,
): Promise<void> {
  const manifest = await readManifestFile(projectId, containerId);
  if (manifest.diskUsage !== undefined) {
    const { diskUsage: _diskUsage, ...unmeasuredManifest } = manifest;
    void _diskUsage;
    await commitArchivedContainer(unmeasuredManifest);
  }
  const store = archivedChatStorage(projectId, containerId);
  await rm(store.manifestPath, { force: true });
  await rm(store.directory, { recursive: true, force: true });
  await Promise.all([
    rm(getArchivedContainerChatsPath(projectId, containerId), { force: true }),
    rm(getArchivedContainerChatArchivesPath(projectId, containerId), {
      force: true,
    }),
    rm(getArchivedContainerSummaryPath(projectId, containerId), {
      force: true,
    }),
    rm(getArchivedContainerTrackedPlansPath(projectId, containerId), {
      force: true,
    }),
    rm(getArchivedContainerAttachmentsDir(projectId, containerId), {
      recursive: true,
      force: true,
    }),
    rm(getArchivedContainerWorkspaceRootDir(projectId, containerId), {
      recursive: true,
      force: true,
    }),
    rm(
      resolveArchivedContainerRelativePath(
        projectId,
        containerId,
        'provider-sessions',
      ),
      {
        recursive: true,
        force: true,
      },
    ),
  ]);
  // Defer the disk-usage module to break its initialization cycle back through
  // archived-container manifest persistence in this module.
  const { scheduleArchivedContainerDiskUsage } =
    await import('./archived-container-disk-usage');
  scheduleArchivedContainerDiskUsage(projectId, containerId, {
    forceAfterCurrent: true,
  });
}
