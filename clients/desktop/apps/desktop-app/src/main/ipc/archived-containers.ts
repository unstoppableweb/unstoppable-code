import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import {
  ARCHIVED_CONTAINER_CHANGES_DEFAULT_PAGE_SIZE,
  ARCHIVED_CONTAINER_CHANGES_MAX_PAGE_SIZE,
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
  type ArchivedChatSummary,
  type ArchivedContainerDeleteRequest,
  type ArchivedContainerDeleteResponse,
  type ArchivedContainerIdentityRequest,
  type ArchivedContainerListAttachmentsResponse,
  type ArchivedContainerListChatsResponse,
  type ArchivedContainerManifest,
  type ArchivedContainerListChangesRequest,
  type ArchivedContainerListChangesResponse,
  type ArchivedContainerListExecutionsResponse,
  type ArchivedContainerListPlansResponse,
  type ArchivedContainerReadChangeDiffRequest,
  type ArchivedContainerReadChangeDiffResponse,
  type ArchivedContainerReadChatRequest,
  type ArchivedContainerReadChatResponse,
  type ArchivedContainerReadExecutionReportRequest,
  type ArchivedContainerReadExecutionReportResponse,
  type ArchivedContainerReadExecutionRequest,
  type ArchivedContainerReadExecutionResponse,
  type ArchivedContainerReadExecutionStepLogRequest,
  type ArchivedContainerReadExecutionStepLogResponse,
  type ArchivedContainerPullRequestRepoStatus,
  type ArchivedContainerRefreshPullRequestsRequest,
  type ArchivedContainerRefreshPullRequestsResponse,
  type ArchivedContainerRestoreRequest,
  type ArchivedContainerRestoreResponse,
  type ArchivedContainerSetLockedRequest,
  type ArchivedContainerSetLockedResponse,
  type ArchivedContainersListRequest,
  type ArchivedContainersListResponse,
  type ChangedFileInfo,
  type ChangedFileStatus,
} from '@canopy/desktop-shared/types';
import {
  getStepLogFilePath,
  listExecutionSummariesWithStates,
  loadExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import { validatePipelineRuntimeIdentifier } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  listArchivedContainers,
  purgeArchivedContainer,
  readArchivedContainerChatArchives,
  readArchivedContainerChats,
  readArchivedContainerManifest,
  readArchivedContainerTrackedPlans,
  setArchivedContainerLocked,
  withArchivedWorkspaceOperationLock,
} from '../lib/archived-containers';
import { restoreArchivedContainer } from '../lib/archived-container-restore';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { projectedWorkspaceLifecycleCommands } from '../canopy-runtime/workspace-lifecycle-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';
import { listAttachmentsInDir } from '../lib/agent-attachments';
import { toArchivedChatSummary } from '../lib/chat-archives';
import {
  getArchivedContainerAttachmentsDir,
  getArchivedContainerExecutionsDir,
} from '../lib/paths';
import { isPathInside } from '../lib/path-safety';
import { isErrnoException } from '../lib/type-guards';
import { retryDeferredTemporaryWorkspaceDeletion } from '../lib/worktree-service';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { validateId } from '../lib/validation';
import {
  assertArchivedGitStateMatchesWorkspace,
  getArchivedContainerChangesService,
} from '../lib/archived-container-git';
import { fetchPrStatusForRepo } from '../lib/github-pr';
import { registerIpcHandler } from './register';
import { isE2eBuild } from '../lib/e2e-gate';
import {
  LEDGER_ARCHIVE_NOT_SAVED_MESSAGE,
  notifyLedgerOfArchivedContainerDeletion,
  readArchivedIdentity,
  recordLedgerMappingBeforeDeletion,
} from '../lib/archived-container-ledger';

type UnknownRecord = Record<string, unknown>;

async function delayArchivedChatListForE2e(containerId: string): Promise<void> {
  if (
    !isE2eBuild() ||
    process.env.CANOPY_E2E_ARCHIVED_CHAT_LIST_DELAY_CONTAINER_ID !== containerId
  ) {
    return;
  }
  const delayMs = Number.parseInt(
    process.env.CANOPY_E2E_ARCHIVED_CHAT_LIST_DELAY_MS ?? '',
    10,
  );
  if (!Number.isInteger(delayMs) || delayMs <= 0 || delayMs > 10_000) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateIdentity(request: ArchivedContainerIdentityRequest): void {
  if (
    !isRecord(request) ||
    typeof request.projectId !== 'string' ||
    typeof request.containerId !== 'string'
  ) {
    throw new Error('Invalid archived container identity');
  }
  validateId(request.projectId, 'projectId');
  validateId(request.containerId, 'containerId');
}

function validateArchivedRepoId(repoId: unknown): asserts repoId is string {
  if (typeof repoId !== 'string' || repoId.length === 0) {
    throw new Error('repoId is required');
  }
  if (
    repoId !== WORKSPACE_ROOT_REPO_ID &&
    repoId !== SINGLE_REPO_USAGE_REPO_ID
  ) {
    validateId(repoId, 'repoId');
  }
}

function validateArchivedFilePath(
  filePath: unknown,
): asserts filePath is string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('filePath is required');
  }
  const segments = filePath.split(/[\\/]+/);
  const hasTraversal = segments.some(
    (segment) => segment === '..' || segment === '.',
  );
  const hasWindowsAbsolutePrefix =
    /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\');
  if (
    hasTraversal ||
    isAbsolute(filePath) ||
    hasWindowsAbsolutePrefix ||
    filePath.includes('\0')
  ) {
    throw new Error('Invalid filePath');
  }
}

function validateListChangesRequest(
  request: ArchivedContainerListChangesRequest,
): void {
  validateIdentity(request);
  if (
    request.cursor !== undefined &&
    (typeof request.cursor !== 'string' || request.cursor.trim().length === 0)
  ) {
    throw new Error('Invalid archived changes cursor');
  }
  if (
    request.limit !== undefined &&
    (typeof request.limit !== 'number' ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > ARCHIVED_CONTAINER_CHANGES_MAX_PAGE_SIZE)
  ) {
    throw new Error(
      `Archived changes limit must be an integer from 1 to ${ARCHIVED_CONTAINER_CHANGES_MAX_PAGE_SIZE}`,
    );
  }
}

const CHANGED_FILE_STATUSES: readonly ChangedFileStatus[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'unmerged',
  'type-changed',
  'untracked',
  'unknown',
];

function isChangedFileStatus(value: unknown): value is ChangedFileStatus {
  return CHANGED_FILE_STATUSES.some((status) => status === value);
}

function sanitizeChangedFile(value: unknown): ChangedFileInfo {
  if (!isRecord(value)) throw new Error('Invalid archived changed file');
  validateArchivedFilePath(value.path);
  const insertions = value.insertions;
  const deletions = value.deletions;
  if (
    !isChangedFileStatus(value.status) ||
    typeof insertions !== 'number' ||
    !Number.isInteger(insertions) ||
    insertions < 0 ||
    typeof deletions !== 'number' ||
    !Number.isInteger(deletions) ||
    deletions < 0
  ) {
    throw new Error('Invalid archived changed file');
  }
  if (value.previousPath !== undefined) {
    validateArchivedFilePath(value.previousPath);
  }
  if (value.repoId !== undefined) {
    try {
      validateArchivedRepoId(value.repoId);
    } catch {
      throw new Error('Invalid archived changed file repoId');
    }
  }
  if (
    value.repoName !== undefined &&
    (typeof value.repoName !== 'string' ||
      value.repoName.length === 0 ||
      isAbsolute(value.repoName) ||
      /^[a-zA-Z]:[\\/]/.test(value.repoName) ||
      value.repoName.startsWith('\\\\') ||
      value.repoName.includes('\0'))
  ) {
    throw new Error('Invalid archived changed file repoName');
  }
  return {
    path: value.path,
    status: value.status,
    insertions,
    deletions,
    ...(value.previousPath !== undefined
      ? { previousPath: value.previousPath }
      : {}),
    ...(value.repoId !== undefined ? { repoId: value.repoId } : {}),
    ...(value.repoName !== undefined ? { repoName: value.repoName } : {}),
  };
}

function sanitizeListChangesResponse(
  value: unknown,
  pageSize: number,
): ArchivedContainerListChangesResponse {
  if (!isRecord(value)) {
    throw new Error('Invalid archived changes response');
  }
  const totalCount = value.totalCount;
  const nextCursor = value.nextCursor;
  if (
    !Array.isArray(value.files) ||
    value.files.length > pageSize ||
    typeof totalCount !== 'number' ||
    !Number.isInteger(totalCount) ||
    totalCount < value.files.length ||
    (nextCursor !== null &&
      (typeof nextCursor !== 'string' || nextCursor.trim().length === 0)) ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new Error('Invalid archived changes response');
  }
  return {
    files: value.files.map(sanitizeChangedFile),
    totalCount,
    nextCursor,
    truncated: value.truncated,
  };
}

function sanitizeReadChangeDiffResponse(
  value: unknown,
  requestedFilePath: string,
): ArchivedContainerReadChangeDiffResponse {
  if (
    !isRecord(value) ||
    typeof value.oldValue !== 'string' ||
    typeof value.newValue !== 'string' ||
    value.filePath !== requestedFilePath ||
    value.source !== 'combined' ||
    typeof value.truncated !== 'boolean' ||
    typeof value.binary !== 'boolean'
  ) {
    throw new Error('Invalid archived change diff response');
  }
  let imagePreview: ArchivedContainerReadChangeDiffResponse['imagePreview'];
  if (value.imagePreview !== undefined) {
    if (
      !isRecord(value.imagePreview) ||
      (value.imagePreview.oldDataUrl !== undefined &&
        typeof value.imagePreview.oldDataUrl !== 'string') ||
      (value.imagePreview.newDataUrl !== undefined &&
        typeof value.imagePreview.newDataUrl !== 'string')
    ) {
      throw new Error('Invalid archived change diff image preview');
    }
    imagePreview = {
      ...(value.imagePreview.oldDataUrl !== undefined
        ? { oldDataUrl: value.imagePreview.oldDataUrl }
        : {}),
      ...(value.imagePreview.newDataUrl !== undefined
        ? { newDataUrl: value.imagePreview.newDataUrl }
        : {}),
    };
  }
  return {
    oldValue: value.oldValue,
    newValue: value.newValue,
    filePath: requestedFilePath,
    source: 'combined',
    truncated: value.truncated,
    binary: value.binary,
    ...(imagePreview !== undefined ? { imagePreview } : {}),
  };
}

export interface ArchivedContainerChangesService {
  listChanges(
    request: ArchivedContainerListChangesRequest,
  ): Promise<ArchivedContainerListChangesResponse>;
  readChangeDiff(
    request: ArchivedContainerReadChangeDiffRequest,
  ): Promise<ArchivedContainerReadChangeDiffResponse>;
}

function turnCountForTab(tab: {
  messages: Array<{ role: string }>;
  transcript?: { userMessageCount?: number };
}): number {
  return (
    tab.transcript?.userMessageCount ??
    tab.messages.filter((message) => message.role === 'user').length
  );
}

function archivedExecutionRuntime(
  projectId: string,
  containerId: string,
): ReturnType<typeof createElectronExecutionRuntime> {
  return {
    ...createElectronExecutionRuntime(),
    executionsDir: getArchivedContainerExecutionsDir(projectId, containerId),
  };
}

function resolveArchivedOutputPath(args: {
  executionsDir: string;
  executionId: string;
  persistedPath: string;
}): string {
  const marker = `${sep}${args.executionId}${sep}`;
  const markerIndex = args.persistedPath.lastIndexOf(marker);
  const relativePath =
    markerIndex >= 0
      ? args.persistedPath.slice(markerIndex + marker.length)
      : basename(args.persistedPath);
  const resolvedPath = resolve(
    args.executionsDir,
    args.executionId,
    relativePath,
  );
  if (!isPathInside(args.executionsDir, resolvedPath)) {
    throw new Error('Invalid archived output path');
  }
  return resolvedPath;
}

/**
 * In-flight pull-request refreshes keyed `${projectId}:${containerId}`. The
 * renderer owns the TTL; this only collapses concurrent callers (multiple
 * windows, a popout, or a re-select landing mid-flight) onto one GitHub
 * round-trip instead of fanning out duplicate requests.
 */
const inFlightPullRequestRefreshes = new Map<
  string,
  Promise<ArchivedContainerRefreshPullRequestsResponse>
>();

async function refreshArchivedPullRequests(
  projectId: string,
  containerId: string,
): Promise<ArchivedContainerRefreshPullRequestsResponse> {
  const manifest = await readArchivedContainerManifest(projectId, containerId);
  // Only version-2 worktree archives record the repository/branch identity a
  // live lookup needs; everything else resolves to an empty result.
  if (manifest.version !== 2) {
    return { repos: [], fetchedAt: new Date().toISOString() };
  }
  await assertArchivedGitStateMatchesWorkspace({
    workspaceId: projectId,
    containerId,
    workspaceType: manifest.workspaceType,
    gitState: manifest.gitState,
  });
  const repos: ArchivedContainerPullRequestRepoStatus[] = await Promise.all(
    manifest.gitState.repositories.map(
      async (repository): Promise<ArchivedContainerPullRequestRepoStatus> => {
        const branchName = repository.branchName;
        if (!branchName) {
          return {
            repoId: repository.repoId,
            repoName: repository.repoName,
            status: null,
          };
        }
        // A failed lookup is indistinguishable from "no PR" to the renderer,
        // which falls back to the immutable archive-time capture either way.
        const status = await fetchPrStatusForRepo(
          repository.referenceRepoPath,
          branchName,
        ).catch(() => null);
        return {
          repoId: repository.repoId,
          repoName: repository.repoName,
          status,
        };
      },
    ),
  );
  return { repos, fetchedAt: new Date().toISOString() };
}

export function registerArchivedContainerHandlers(
  runtime: {
    dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>;
    resolveCaller: DesktopIpcCallerResolver;
  },
  changesService: ArchivedContainerChangesService = getArchivedContainerChangesService(),
): void {
  registerIpcHandler<
    [ArchivedContainersListRequest],
    ArchivedContainersListResponse
  >(IPC_CHANNELS.archivedContainersList, async (_event, request) => {
    validateId(request.projectId, 'projectId');
    return listArchivedContainers(request.projectId);
  });

  registerIpcHandler<
    [ArchivedContainerListChangesRequest],
    ArchivedContainerListChangesResponse
  >(IPC_CHANNELS.archivedContainersListChanges, async (_event, request) => {
    validateListChangesRequest(request);
    const safeRequest: ArchivedContainerListChangesRequest = {
      projectId: request.projectId,
      containerId: request.containerId,
      ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    };
    const response = await changesService.listChanges(safeRequest);
    return sanitizeListChangesResponse(
      response,
      safeRequest.limit ?? ARCHIVED_CONTAINER_CHANGES_DEFAULT_PAGE_SIZE,
    );
  });

  registerIpcHandler<
    [ArchivedContainerReadChangeDiffRequest],
    ArchivedContainerReadChangeDiffResponse
  >(IPC_CHANNELS.archivedContainersReadChangeDiff, async (_event, request) => {
    validateIdentity(request);
    validateArchivedRepoId(request.repoId);
    validateArchivedFilePath(request.filePath);
    const safeRequest: ArchivedContainerReadChangeDiffRequest = {
      projectId: request.projectId,
      containerId: request.containerId,
      repoId: request.repoId,
      filePath: request.filePath,
    };
    const response = await changesService.readChangeDiff(safeRequest);
    return sanitizeReadChangeDiffResponse(response, safeRequest.filePath);
  });

  registerIpcHandler<
    [ArchivedContainerRefreshPullRequestsRequest],
    ArchivedContainerRefreshPullRequestsResponse
  >(
    IPC_CHANNELS.archivedContainersRefreshPullRequests,
    async (_event, request) => {
      validateIdentity(request);
      const key = `${request.projectId}:${request.containerId}`;
      const existing = inFlightPullRequestRefreshes.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const pending = refreshArchivedPullRequests(
        request.projectId,
        request.containerId,
      ).finally(() => {
        inFlightPullRequestRefreshes.delete(key);
      });
      inFlightPullRequestRefreshes.set(key, pending);
      return pending;
    },
  );

  registerIpcHandler<
    [ArchivedContainerIdentityRequest],
    ArchivedContainerListChatsResponse
  >(IPC_CHANNELS.archivedContainersListChats, async (_event, request) => {
    validateIdentity(request);
    await delayArchivedChatListForE2e(request.containerId);
    const [manifest, chats, archives] = await Promise.all([
      readArchivedContainerManifest(request.projectId, request.containerId),
      readArchivedContainerChats(request.projectId, request.containerId),
      readArchivedContainerChatArchives(request.projectId, request.containerId),
    ]);
    const now = Date.now();
    const summaries = new Map<string, ArchivedChatSummary>(
      archives.archived.map((entry) => [
        entry.tab.id,
        { ...toArchivedChatSummary(entry, now), archived: true as const },
      ]),
    );
    for (const tab of chats.tabs) {
      if ((tab.kind ?? 'chat') !== 'chat') continue;
      summaries.set(
        tab.id,
        toArchivedChatSummary(
          {
            tab,
            archivedAt: manifest.archivedAt,
            turnCount: turnCountForTab(tab),
            ...(tab.unread ? { unread: true } : {}),
          },
          now,
        ),
      );
    }
    return {
      chats: Array.from(summaries.values()).sort((left, right) =>
        right.archivedAt.localeCompare(left.archivedAt),
      ),
    };
  });

  registerIpcHandler<
    [ArchivedContainerReadChatRequest],
    ArchivedContainerReadChatResponse
  >(IPC_CHANNELS.archivedContainersReadChat, async (_event, request) => {
    validateIdentity(request);
    validateId(request.chatId, 'chatId');
    const [chats, archives] = await Promise.all([
      readArchivedContainerChats(request.projectId, request.containerId, {
        chatIds: [request.chatId],
        pageOnly: true,
      }),
      readArchivedContainerChatArchives(
        request.projectId,
        request.containerId,
        { chatIds: [request.chatId], pageOnly: true },
      ),
    ]);
    const tab =
      chats.tabs.find((candidate) => candidate.id === request.chatId) ??
      archives.archived.find((entry) => entry.tab.id === request.chatId)?.tab;
    if (!tab) throw new Error(`Archived chat ${request.chatId} was not found`);
    return { tab };
  });

  registerIpcHandler<
    [ArchivedContainerIdentityRequest],
    ArchivedContainerListExecutionsResponse
  >(IPC_CHANNELS.archivedContainersListExecutions, async (_event, request) => {
    validateIdentity(request);
    await readArchivedContainerManifest(request.projectId, request.containerId);
    const entries = await listExecutionSummariesWithStates(
      getArchivedContainerExecutionsDir(request.projectId, request.containerId),
    );
    const statesById: Record<string, ExecutionState> = {};
    for (const entry of entries) {
      statesById[entry.summary.id] = entry.state;
    }
    return {
      executions: entries.map((entry) => entry.summary),
      statesById,
    };
  });

  registerIpcHandler<
    [ArchivedContainerIdentityRequest],
    ArchivedContainerListAttachmentsResponse
  >(IPC_CHANNELS.archivedContainersListAttachments, async (_event, request) => {
    validateIdentity(request);
    await readArchivedContainerManifest(request.projectId, request.containerId);
    return {
      attachments: await listAttachmentsInDir(
        getArchivedContainerAttachmentsDir(
          request.projectId,
          request.containerId,
        ),
      ),
    };
  });

  registerIpcHandler<
    [ArchivedContainerIdentityRequest],
    ArchivedContainerListPlansResponse
  >(IPC_CHANNELS.archivedContainersListPlans, async (_event, request) => {
    validateIdentity(request);
    const file = await readArchivedContainerTrackedPlans(
      request.projectId,
      request.containerId,
    );
    return {
      plans: [...file.plans].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    };
  });

  registerIpcHandler<
    [ArchivedContainerReadExecutionRequest],
    ArchivedContainerReadExecutionResponse
  >(IPC_CHANNELS.archivedContainersReadExecution, async (_event, request) => {
    validateIdentity(request);
    validateId(request.executionId, 'executionId');
    await readArchivedContainerManifest(request.projectId, request.containerId);
    const state = await loadExecutionState(
      request.executionId,
      getArchivedContainerExecutionsDir(request.projectId, request.containerId),
    );
    if (!state)
      throw new Error(`Execution ${request.executionId} was not found`);
    return state;
  });

  registerIpcHandler<
    [ArchivedContainerReadExecutionReportRequest],
    ArchivedContainerReadExecutionReportResponse
  >(
    IPC_CHANNELS.archivedContainersReadExecutionReport,
    async (_event, request) => {
      validateIdentity(request);
      validateId(request.executionId, 'executionId');
      await readArchivedContainerManifest(
        request.projectId,
        request.containerId,
      );
      if (request.kind !== 'text' && request.kind !== 'json') {
        throw new Error('Invalid report kind');
      }
      const executionsDir = getArchivedContainerExecutionsDir(
        request.projectId,
        request.containerId,
      );
      const state = await loadExecutionState(
        request.executionId,
        executionsDir,
      );
      if (!state)
        throw new Error(`Execution ${request.executionId} was not found`);
      const persistedPath =
        request.kind === 'text'
          ? state.report_outputs?.report_file
          : state.report_outputs?.report_json_file;
      if (!persistedPath) throw new Error('Execution report was not found');
      const filePath = resolveArchivedOutputPath({
        executionsDir,
        executionId: request.executionId,
        persistedPath,
      });
      return { content: await readFile(filePath, 'utf8'), filePath };
    },
  );

  registerIpcHandler<
    [ArchivedContainerReadExecutionStepLogRequest],
    ArchivedContainerReadExecutionStepLogResponse
  >(
    IPC_CHANNELS.archivedContainersReadExecutionStepLog,
    async (_event, request) => {
      validateIdentity(request);
      validateId(request.executionId, 'executionId');
      // Persisted pipeline-authored ids use the documented IPC exception:
      // legacy executions may contain hyphens and matrix ids start with underscores.
      validatePipelineRuntimeIdentifier(request.jobId, 'jobId');
      validatePipelineRuntimeIdentifier(request.stepId, 'stepId');
      const legacyMatrixChildId =
        'matrix_child_id' in request ? request.matrix_child_id : undefined;
      if (legacyMatrixChildId !== undefined) {
        if (typeof legacyMatrixChildId !== 'string') {
          throw new Error('Invalid matrix_child_id');
        }
        validateId(legacyMatrixChildId, 'matrix_child_id');
      }
      await readArchivedContainerManifest(
        request.projectId,
        request.containerId,
      );
      const runtime = archivedExecutionRuntime(
        request.projectId,
        request.containerId,
      );
      const state = await loadExecutionState(
        request.executionId,
        runtime.executionsDir,
      );
      const definition = state?.job_definitions[request.jobId];
      const filePath = request.logFilePath
        ? resolveArchivedOutputPath({
            executionsDir: runtime.executionsDir,
            executionId: request.executionId,
            persistedPath: request.logFilePath,
          })
        : getStepLogFilePath(
            runtime,
            request.executionId,
            definition?.artifact_locator?.job_id ?? request.jobId,
            request.stepId,
            request.attempt ?? 0,
            request.iteration ?? 1,
            request.recovery ?? 0,
            definition?.artifact_locator?.matrix_child_id,
          );
      if (!isPathInside(runtime.executionsDir, filePath)) {
        throw new Error('Invalid archived step log path');
      }
      try {
        const lines = (await readFile(filePath, 'utf8'))
          .replace(/\r\n/g, '\n')
          .split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        return { lines };
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
          return { lines: [] };
        }
        throw error;
      }
    },
  );

  registerIpcHandler<
    [ArchivedContainerRestoreRequest],
    ArchivedContainerRestoreResponse
  >(IPC_CHANNELS.archivedContainersRestore, async (event, request) => {
    validateIdentity(request);
    // Projected as core.archive.container.restore (W7b-2a).
    return projectedWorkspaceLifecycleCommands({
      dispatcher: runtime.dispatcher,
      caller: runtime.resolveCaller(event),
    }).restoreArchive(
      { workspaceId: request.projectId, containerId: request.containerId },
      () => restoreArchivedContainer(request.projectId, request.containerId),
    );
  });

  registerIpcHandler<
    [ArchivedContainerSetLockedRequest],
    ArchivedContainerSetLockedResponse
  >(IPC_CHANNELS.archivedContainersSetLocked, async (_event, request) => {
    validateIdentity(request);
    if (typeof request.locked !== 'boolean') {
      throw new Error('locked must be a boolean');
    }
    return setArchivedContainerLocked(
      request.projectId,
      request.containerId,
      request.locked,
    );
  });

  registerIpcHandler<
    [ArchivedContainerDeleteRequest],
    ArchivedContainerDeleteResponse
  >(IPC_CHANNELS.archivedContainersDelete, async (_event, request) => {
    validateIdentity(request);
    if (
      request.onlyIfDeleted !== undefined &&
      typeof request.onlyIfDeleted !== 'boolean'
    ) {
      throw new Error('onlyIfDeleted must be a boolean');
    }
    const { deleted, manifest } = await withArchivedWorkspaceOperationLock(
      request.projectId,
      async (): Promise<{
        deleted: boolean;
        manifest: ArchivedContainerManifest | null;
      }> => {
        // Read the identity under the lock the purge takes, so a restore
        // cannot record a destination between this read and the purge.
        const identity = await readArchivedIdentity(
          request.projectId,
          request.containerId,
        );
        if (identity && !(await recordLedgerMappingBeforeDeletion(identity))) {
          throw new Error(LEDGER_ARCHIVE_NOT_SAVED_MESSAGE);
        }
        return {
          deleted: await purgeArchivedContainer(
            request.projectId,
            request.containerId,
            { onlyIfDeleted: request.onlyIfDeleted },
          ),
          manifest: identity,
        };
      },
    );
    if (deleted) {
      if (manifest) notifyLedgerOfArchivedContainerDeletion(manifest);
      await retryDeferredTemporaryWorkspaceDeletion(request.projectId).catch(
        () => null,
      );
    }
    return { deleted };
  });
}
