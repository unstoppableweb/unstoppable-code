import { classifyError } from '@canopy/protocol/app-errors/classification';
import { withWorktreeGitRead } from '../lib/worktree-read-availability';
import {
  revertFileThroughWorker,
  type WorkerGitLocalMutationDispatcher,
} from '../canopy-runtime/worker-git-local-mutations-dispatch';
import { logMainProcessError } from '../lib/main-process-logging';
import { realpathSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type ActivityChangedFilesRequest,
  type ActivityChangedFilesResponse,
  type ActivityFileDiffRequest,
  type ActivityFileDiffResponse,
  type ActivityLiveBgTasksChangedEvent,
  type ActivityLiveBgTasksRequest,
  type ActivityLiveBgTasksResponse,
  type ActivityReadFullOutputRequest,
  type ActivityReadFullOutputResponse,
  type ActivityReadWorkflowRunRequest,
  type ActivityReadWorkflowAgentTranscriptRequest,
  type ActivityReadWorkflowAgentTranscriptResponse,
  type ActivityRevertFileRequest,
  type ActivityStartOutputPollingRequest,
  type ActivityStopBgProcessRequest,
  type ActivityStopBgProcessOutcome,
  type ActivityStopOutputPollingRequest,
  type ChangedFileInfo,
  type ChangedFileStatus,
  type FileDiffSource,
  type TurnFileDiffRequest,
  type TurnFileDiffResponse,
  type WorkflowRunState,
} from '@canopy/desktop-shared/types';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { revalidateDefaultBranchInBackground } from '../lib/git-default-branch';
import {
  fetchOrigin,
  getChangedFilesList,
  getFileDiffUncommitted,
  getFileDiffCommitted,
  getFileDiffCombined,
  getFileDiffBetweenTrees,
  type FileDiffContent,
} from '../lib/git';
import { startOutputPolling, stopOutputPolling } from '../lib/bg-output-poller';
import {
  deriveWorkflowRunStatePath,
  deriveWorkflowAgentTranscriptPath,
  deriveWorkflowJournalPath,
  deriveWorkflowAgentMetaPath,
  assertAllowedWorkflowPath,
  parseWorkflowRunState,
  parseWorkflowJournalAgents,
  parseAgentMeta,
  extractAgentTranscriptStartedAt,
  extractAgentPromptPreview,
  buildLiveWorkflowRunState,
  readWorkflowAgentTranscript,
  readWorkflowArtifactFile,
  type WorkflowLiveAgentDetails,
} from '../lib/workflow-run-reader';
import {
  getLiveBackgroundTasksForChat,
  getLiveBackgroundTaskSnapshot,
  isSessionUnavailableForTaskStopError,
  subscribeLiveBackgroundTasks,
  stopTaskForSession,
} from '../agents/session-manager';
import { parseDelegationSessionKey } from '../agents/delegation/activity';
import { sendToAllWindows } from '../lib/window-send';
import { emitSessionEndedBackgroundTaskNotification } from '../lib/session-ended-background-tasks';
import { validateId } from '../lib/validation';
import { isPathInside } from '../lib/path-safety';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { resolveEffectiveBaseBranchForRepo } from '../lib/worktree-base-branches';
import { registerIpcHandler } from './register';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import { resolveSharedContainerViewerReadRoots } from '../shared-containers/read/viewer-root';
import { assertWritableScope } from '../lib/read-only-scope';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { WorkerGitDispatcher } from '../canopy-runtime/worker-git-adapter';
import {
  listCommittedChangedFiles,
  listUncommittedChangedFiles,
} from '../canopy-runtime/worker-git-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';

const SAFE_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_FULL_OUTPUT_BYTES = 1024 * 1024;
const MAX_FULL_OUTPUT_LINES = 5000;
let unsubscribeLiveBackgroundTasks: (() => void) | null = null;
const pendingLiveBackgroundTaskKeys = new Set<string>();

function flushLiveBackgroundTaskChanges(): void {
  const sessionKeys = Array.from(pendingLiveBackgroundTaskKeys);
  pendingLiveBackgroundTaskKeys.clear();

  for (const sessionKey of sessionKeys) {
    const chat = parseDelegationSessionKey(sessionKey);
    if (!chat) continue;

    const tasks = getLiveBackgroundTasksForChat(
      chat.projectId,
      chat.worktreeId,
      chat.chatId,
    );
    const event: ActivityLiveBgTasksChangedEvent = {
      ...chat,
      sessionActive: tasks !== undefined,
      liveTasks: tasks ?? [],
    };

    try {
      sendToAllWindows(IPC_CHANNELS.activityLiveBgTasksChanged, event);
    } catch (error: unknown) {
      logMainProcessError(
        'Live background-task change broadcast failed',
        error,
      );
    }
  }
}

function validateTaskId(value: string, label: string): void {
  if (!value || !SAFE_TASK_ID_RE.test(value)) {
    throw new Error(
      `Invalid ${label}: must be alphanumeric with hyphens, dots, or underscores`,
    );
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function assertAllowedOutputPath(filePath: string): string {
  const resolved = resolve(filePath);
  const realResolved = safeRealpath(resolved);

  // On macOS /tmp is a symlink to /private/tmp, but os.tmpdir() returns
  // /var/folders/.../T/ — a completely different directory.  Allow both.
  const allowedRoots = [
    safeRealpath(resolve(tmpdir())),
    safeRealpath('/tmp'),
    safeRealpath('/private/tmp'),
  ];

  const isAllowed = allowedRoots.some((root) => {
    const rel = relative(root, realResolved);
    return !rel.startsWith('..') && !isAbsolute(rel);
  });

  if (!isAllowed) {
    throw new Error('outputFile must be under a temp directory');
  }

  return resolved;
}

const MAX_LIVE_PROMPT_PREFIX_BYTES = 16 * 1024;
const LIVE_PROMPT_MAX_CHARS = 400;
const MAX_LIVE_META_BYTES = 64 * 1024;

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

/** Read at most `maxBytes` of a small, best-effort workflow file. */
async function readWorkflowFile(
  derivedPath: string,
  maxBytes: number,
): Promise<string> {
  const file = await open(assertAllowedWorkflowPath(derivedPath), 'r');
  try {
    const fileStat = await file.stat();
    const length = Math.min(fileStat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

async function readWorkflowFilePrefix(
  derivedPath: string,
  maxBytes: number,
): Promise<string> {
  const validated = assertAllowedWorkflowPath(derivedPath);
  const file = await open(validated, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

/** Build live workflow progress from the journal and per-agent files. */
async function buildLiveWorkflowRun(
  transcriptDir: string,
  runId: string,
): Promise<WorkflowRunState | null> {
  let journalText: string;
  let journalModifiedAt: number | undefined;
  try {
    const journalPath = deriveWorkflowJournalPath(transcriptDir);
    journalText = await readWorkflowArtifactFile(
      assertAllowedWorkflowPath(journalPath),
    );
    try {
      journalModifiedAt = (await stat(assertAllowedWorkflowPath(journalPath)))
        .mtimeMs;
    } catch {
      // The journal may be replaced between its read and stat.
    }
  } catch {
    return null;
  }

  const journalAgents = parseWorkflowJournalAgents(journalText);
  if (journalAgents.length === 0) {
    return null;
  }

  const agentDetails: WorkflowLiveAgentDetails[] = [];
  for (const { agentId } of journalAgents) {
    let meta: ReturnType<typeof parseAgentMeta> = {};
    try {
      const metaText = await readWorkflowFile(
        deriveWorkflowAgentMetaPath(transcriptDir, agentId),
        MAX_LIVE_META_BYTES,
      );
      meta = parseAgentMeta(metaText);
    } catch {
      // Meta is best-effort; the id remains a final label fallback.
    }

    let promptPreview: string | undefined;
    let startedAt: number | undefined;
    let modifiedAt: number | undefined;
    try {
      const transcriptPath = deriveWorkflowAgentTranscriptPath(
        transcriptDir,
        agentId,
      );
      const prefix = await readWorkflowFilePrefix(
        transcriptPath,
        MAX_LIVE_PROMPT_PREFIX_BYTES,
      );
      const extracted = extractAgentPromptPreview(prefix);
      if (extracted) {
        promptPreview = truncateText(
          extracted.replace(/\s+/g, ' '),
          LIVE_PROMPT_MAX_CHARS,
        );
      }
      startedAt = extractAgentTranscriptStartedAt(prefix);
    } catch {
      // transcript may not exist yet; fall back to an id-based label.
    }
    try {
      const transcriptPath = deriveWorkflowAgentTranscriptPath(
        transcriptDir,
        agentId,
      );
      modifiedAt = (await stat(assertAllowedWorkflowPath(transcriptPath)))
        .mtimeMs;
    } catch {
      // Transcript mtime is best-effort, as the file may not exist yet.
    }

    agentDetails.push({
      agentId,
      ...meta,
      ...(promptPreview ? { promptPreview } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
    });
  }

  return buildLiveWorkflowRunState(
    runId,
    journalText,
    agentDetails,
    journalModifiedAt,
  );
}

async function readOutputTail(filePath: string): Promise<{
  lines: string[];
  truncated: boolean;
}> {
  const fileStat = await stat(filePath);
  const start = Math.max(0, fileStat.size - MAX_FULL_OUTPUT_BYTES);
  const length = fileStat.size - start;
  if (length <= 0) {
    return { lines: [], truncated: false };
  }

  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const result = await file.read(buffer, 0, length, start);
    const content = buffer
      .subarray(0, result.bytesRead)
      .toString('utf8')
      .replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const cappedLines =
      lines.length > MAX_FULL_OUTPUT_LINES
        ? lines.slice(-MAX_FULL_OUTPUT_LINES)
        : lines;
    return {
      lines: cappedLines,
      truncated:
        start > 0 ||
        cappedLines.length < lines.length ||
        result.bytesRead < length,
    };
  } finally {
    await file.close();
  }
}

function validateFilePath(filePath: string): void {
  const hasTraversal = filePath
    .split(/[\\/]+/)
    .some((segment) => segment === '..');

  if (!filePath || hasTraversal || isAbsolute(filePath)) {
    throw new Error('Invalid filePath');
  }
}

function validateChangedFileStatus(status: ChangedFileStatus): void {
  const validStatuses: ChangedFileStatus[] = [
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
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid file status');
  }
}

function resolveRepoPath(
  worktreePath: string,
  projectId: string,
  repoId?: string,
): string {
  if (repoId && isMultiRepoWorkspace(projectId)) {
    if (repoId === WORKSPACE_ROOT_REPO_ID) {
      return worktreePath;
    }
    validateId(repoId, 'repoId');
    const repoPath = join(worktreePath, 'repos', repoId);
    if (!isPathInside(worktreePath, repoPath)) {
      throw new Error('Invalid repoId');
    }
    return repoPath;
  }
  return worktreePath;
}

function sortByPath(files: ChangedFileInfo[]): ChangedFileInfo[] {
  return files.sort((left, right) =>
    `${left.repoName ?? ''}/${left.path}`.localeCompare(
      `${right.repoName ?? ''}/${right.path}`,
    ),
  );
}

const AUTOMATIC_ACTIVITY_FETCH_TTL_MS = 5 * 60_000;
const AUTOMATIC_ACTIVITY_FETCH_OPTIONS = Object.freeze({
  ttlMs: AUTOMATIC_ACTIVITY_FETCH_TTL_MS,
  backgroundPriority: true,
});
const AUTOMATIC_ACTIVITY_FETCH_HEAD_START_MS = 3_000;

/**
 * Changed Files and its diffs show local state and must not wait on the
 * network. A remote whose credential helper never answers would otherwise keep
 * them empty for as long as git allows. A normal fetch still lands within the
 * head start, so committed files reflect the fresh remote; a slow one keeps
 * running in the background (fetches are deduplicated) and a later refresh
 * picks it up.
 */
async function waitForFetchHeadStart(fetch: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    fetch,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, AUTOMATIC_ACTIVITY_FETCH_HEAD_START_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function getWorkspaceChangedFiles(
  dispatcher: WorkerGitDispatcher,
  caller: CanopyCallerDescriptor,
  workspaceId: string,
  worktreeId: string,
): Promise<ActivityChangedFilesResponse> {
  const worktreePath = resolveWorktreeCwd(workspaceId, worktreeId);
  const repoEntries = await listWorkspaceWorktreeRepoEntries(
    workspaceId,
    worktreePath,
  );

  const results = await Promise.all(
    repoEntries.map(async (entry) => {
      await waitForFetchHeadStart(
        fetchOrigin(entry.repoPath, AUTOMATIC_ACTIVITY_FETCH_OPTIONS),
      );
      // `ls-remote` can wait on a credential helper as long as the fetch, so
      // the remote default branch is revalidated in the background instead.
      revalidateDefaultBranchInBackground(entry.repoPath);
      const effectiveBaseBranch = await resolveEffectiveBaseBranchForRepo({
        projectId: workspaceId,
        worktreeId,
        repoId: entry.repoId,
        repoPath: entry.repoPath,
        allowRemoteLookup: false,
      });
      const target = {
        projectId: workspaceId,
        worktreeId,
        repoId: entry.repoId,
        repoPath: entry.repoPath,
      };
      const [uncommitted, committed] = await Promise.all([
        listUncommittedChangedFiles(dispatcher, caller, target).catch(() => []),
        listCommittedChangedFiles(
          dispatcher,
          caller,
          target,
          effectiveBaseBranch.branch ?? undefined,
        ).catch(() => []),
      ]);
      const enrich = (file: ChangedFileInfo): ChangedFileInfo => ({
        ...file,
        repoId: entry.repoId,
        repoName: entry.repoName,
      });
      return {
        uncommitted: uncommitted.map(enrich),
        committed: committed.map(enrich),
      };
    }),
  );

  return {
    uncommitted: sortByPath(results.flatMap((r) => r.uncommitted)),
    committed: sortByPath(results.flatMap((r) => r.committed)),
  };
}

async function getViewerChangedFiles(
  containerId: string,
): Promise<ActivityChangedFilesResponse> {
  const roots = await resolveSharedContainerViewerReadRoots(containerId);
  const revisionId = roots[0]?.revisionId;
  if (!revisionId) return { uncommitted: [], committed: [] };
  const reader = getSharedContainerReader();
  const repositories = await reader.listRepositories({
    containerId,
    revisionId,
  });
  const uncommitted: ChangedFileInfo[] = [];
  const committed: ChangedFileInfo[] = [];
  for (const repository of repositories) {
    let cursor: string | undefined;
    do {
      const page = await reader.listRepositoryTree({
        containerId,
        revisionId,
        repoId: repository.repoId,
        ...(cursor ? { cursor } : {}),
        limit: 100,
      });
      for (const item of page.items) {
        if (item.kind !== 'file' || !item.status || !item.source) continue;
        const target = item.source === 'committed' ? committed : uncommitted;
        target.push({
          path: item.path,
          status: item.status,
          insertions: item.insertions ?? 0,
          deletions: item.deletions ?? 0,
          repoId: repository.repoId,
          repoName: repository.repoName,
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  return {
    uncommitted: sortByPath(uncommitted),
    committed: sortByPath(committed),
  };
}

export function registerActivityPanelHandlers(
  getWindow: () => BrowserWindow | null,
  runtime: {
    dispatcher: WorkerGitDispatcher & WorkerGitLocalMutationDispatcher;
    resolveCaller: DesktopIpcCallerResolver;
  },
): void {
  unsubscribeLiveBackgroundTasks?.();
  unsubscribeLiveBackgroundTasks = subscribeLiveBackgroundTasks(
    (sessionKey): void => {
      const wasEmpty = pendingLiveBackgroundTaskKeys.size === 0;
      pendingLiveBackgroundTaskKeys.add(sessionKey);
      if (wasEmpty) {
        // This batches provider bursts only; renderer ordering against chat events is not guaranteed or required.
        queueMicrotask(flushLiveBackgroundTaskChanges);
      }
    },
  );

  registerIpcHandler<
    [ActivityChangedFilesRequest],
    ActivityChangedFilesResponse
  >(IPC_CHANNELS.activityChangedFiles, async (event, request) => {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
      return getViewerChangedFiles(request.worktreeId);
    return withWorktreeGitRead<ActivityChangedFilesResponse>(
      request.projectId,
      request.worktreeId,
      { uncommitted: [], committed: [] },
      async () => {
        if (isMultiRepoWorkspace(request.projectId)) {
          return getWorkspaceChangedFiles(
            runtime.dispatcher,
            runtime.resolveCaller(event),
            request.projectId,
            request.worktreeId,
          );
        }

        const worktreePath = resolveWorktreeCwd(
          request.projectId,
          request.worktreeId,
        );
        await waitForFetchHeadStart(
          fetchOrigin(worktreePath, AUTOMATIC_ACTIVITY_FETCH_OPTIONS),
        );
        // `ls-remote` can wait on a credential helper as long as the fetch, so the
        // remote default branch is revalidated in the background instead.
        revalidateDefaultBranchInBackground(worktreePath);
        const effectiveBaseBranch = await resolveEffectiveBaseBranchForRepo({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          repoPath: worktreePath,
          allowRemoteLookup: false,
        });
        const caller = runtime.resolveCaller(event);
        const target = {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          repoId: WORKSPACE_ROOT_REPO_ID,
          repoPath: worktreePath,
        };
        const [uncommitted, committed] = await Promise.all([
          listUncommittedChangedFiles(runtime.dispatcher, caller, target),
          listCommittedChangedFiles(
            runtime.dispatcher,
            caller,
            target,
            effectiveBaseBranch.branch ?? undefined,
          ).catch(() => []),
        ]);

        return { uncommitted, committed };
      },
    );
  });

  registerIpcHandler<[ActivityFileDiffRequest], ActivityFileDiffResponse>(
    IPC_CHANNELS.activityFileDiff,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateFilePath(request.filePath);

      const validSources: FileDiffSource[] = [
        'uncommitted',
        'committed',
        'combined',
      ];
      if (!validSources.includes(request.source)) {
        throw new Error('Invalid source');
      }

      if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
        if (!request.repoId) throw new Error('repoId is required');
        const roots = await resolveSharedContainerViewerReadRoots(
          request.worktreeId,
        );
        const revisionId = roots[0]?.revisionId;
        if (!revisionId)
          throw new Error('Shared-container revision is unavailable');
        const reader = getSharedContainerReader();
        const read = (
          source: 'uncommitted' | 'committed',
        ): Promise<FileDiffContent> =>
          reader.readOverlayDiff({
            containerId: request.worktreeId,
            revisionId,
            repoId: request.repoId as string,
            path: request.filePath,
            source,
          });
        const result =
          request.source === 'combined'
            ? await Promise.allSettled([
                read('committed'),
                read('uncommitted'),
              ]).then(([committed, uncommitted]) => {
                if (
                  committed.status === 'rejected' &&
                  uncommitted.status === 'rejected'
                ) {
                  throw uncommitted.reason;
                }
                const first =
                  committed.status === 'fulfilled'
                    ? committed.value
                    : undefined;
                const second =
                  uncommitted.status === 'fulfilled'
                    ? uncommitted.value
                    : undefined;
                return {
                  oldValue: first?.oldValue ?? second?.oldValue ?? '',
                  newValue: second?.newValue ?? first?.newValue ?? '',
                  truncated:
                    first?.truncated === true || second?.truncated === true,
                  binary: first?.binary === true || second?.binary === true,
                  imagePreview: second?.imagePreview ?? first?.imagePreview,
                };
              })
            : await read(request.source);
        return {
          oldValue: result.oldValue,
          newValue: result.newValue,
          filePath: request.filePath,
          source: request.source,
          truncated: result.truncated,
          binary: result.binary,
          imagePreview: result.imagePreview,
        };
      }

      const worktreePath = resolveWorktreeCwd(
        request.projectId,
        request.worktreeId,
      );
      const repoPath = resolveRepoPath(
        worktreePath,
        request.projectId,
        request.repoId,
      );
      await waitForFetchHeadStart(fetchOrigin(repoPath));
      revalidateDefaultBranchInBackground(repoPath);
      const effectiveBaseBranch = await resolveEffectiveBaseBranchForRepo({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        repoId:
          request.repoId === WORKSPACE_ROOT_REPO_ID
            ? WORKSPACE_ROOT_REPO_ID
            : request.repoId,
        repoPath,
        allowRemoteLookup: false,
      });

      let result: {
        oldValue: string;
        newValue: string;
        truncated: boolean;
        binary: boolean;
        imagePreview?: ActivityFileDiffResponse['imagePreview'];
      };
      switch (request.source) {
        case 'uncommitted':
          result = await getFileDiffUncommitted(repoPath, request.filePath);
          break;
        case 'committed':
          result = await getFileDiffCommitted(
            repoPath,
            request.filePath,
            effectiveBaseBranch.branch ?? undefined,
          );
          break;
        case 'combined':
          result = await getFileDiffCombined(
            repoPath,
            request.filePath,
            effectiveBaseBranch.branch ?? undefined,
          );
          break;
      }

      return {
        oldValue: result.oldValue,
        newValue: result.newValue,
        filePath: request.filePath,
        source: request.source,
        truncated: result.truncated,
        binary: result.binary,
        imagePreview: result.imagePreview,
      };
    },
  );

  registerIpcHandler<[TurnFileDiffRequest], TurnFileDiffResponse>(
    IPC_CHANNELS.activityTurnFileDiff,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateFilePath(request.filePath);

      const SHA_RE = /^[0-9a-f]{40,64}$/;
      if (!SHA_RE.test(request.startTree) || !SHA_RE.test(request.endTree)) {
        throw new Error('Invalid tree SHA');
      }

      const worktreePath = resolveWorktreeCwd(
        request.projectId,
        request.worktreeId,
      );
      const repoPath = resolveRepoPath(
        worktreePath,
        request.projectId,
        request.repoId,
      );

      const result = await getFileDiffBetweenTrees(
        repoPath,
        request.filePath,
        request.startTree,
        request.endTree,
      );

      return {
        oldValue: result.oldValue,
        newValue: result.newValue,
        filePath: request.filePath,
        truncated: result.truncated,
        binary: result.binary,
        imagePreview: result.imagePreview,
      };
    },
  );

  registerIpcHandler<[ActivityRevertFileRequest], void>(
    IPC_CHANNELS.activityRevertFile,
    async (event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      assertWritableScope(request.projectId);
      validateFilePath(request.filePath);
      validateChangedFileStatus(request.status);
      if (request.previousPath !== undefined) {
        validateFilePath(request.previousPath);
      }
      if (request.status === 'renamed' && request.previousPath === undefined) {
        throw new Error('previousPath is required for renamed files');
      }

      const worktreePath = resolveWorktreeCwd(
        request.projectId,
        request.worktreeId,
      );
      const repoPath = resolveRepoPath(
        worktreePath,
        request.projectId,
        request.repoId,
      );
      const currentFile = (await getChangedFilesList(repoPath)).find(
        (file) => file.path === request.filePath,
      );
      // Prefer the current git state; fall back to modal snapshot data only
      // when the file is no longer present in the latest changed-files list.
      const revertStatus = currentFile ? currentFile.status : request.status;
      const revertPreviousPath = currentFile
        ? currentFile.previousPath
        : request.previousPath;
      if (revertStatus === 'renamed' && revertPreviousPath === undefined) {
        throw new Error('previousPath is required for renamed files');
      }

      await revertFileThroughWorker(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        repoPath,
        {
          filePath: request.filePath,
          status: revertStatus,
          ...(revertPreviousPath === undefined
            ? {}
            : { previousPath: revertPreviousPath }),
        },
      );
    },
  );

  registerIpcHandler<
    [ActivityStopBgProcessRequest],
    ActivityStopBgProcessOutcome
  >(IPC_CHANNELS.activityStopBgProcess, async (_event, request) => {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateId(request.chatId, 'chatId');
    validateTaskId(request.taskId, 'taskId');

    // A task that is already dead is a success, not a failure. It will not
    // produce a provider terminal notification, so Canopy emits a synthetic
    // one. A running task is reconciled only by the provider notification.
    // Genuine provider failures still reject.
    let deadTaskOutcome: 'none' | 'session-ended' | 'already-finished';
    try {
      deadTaskOutcome =
        (await stopTaskForSession(
          request.projectId,
          request.worktreeId,
          request.chatId,
          request.taskId,
        )) === 'already-finished'
          ? 'already-finished'
          : 'none';
    } catch (error: unknown) {
      if (!isSessionUnavailableForTaskStopError(error)) {
        throw error;
      }
      deadTaskOutcome = 'session-ended';
    }

    if (deadTaskOutcome !== 'none') {
      emitSessionEndedBackgroundTaskNotification(
        {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: request.chatId,
        },
        { taskId: request.taskId },
        ...(deadTaskOutcome === 'already-finished'
          ? [
              {
                reason: 'already_finished',
                summary: 'This task had already finished',
              },
            ]
          : []),
      );
      return deadTaskOutcome;
    }

    return 'stopped';
  });

  registerIpcHandler<[ActivityLiveBgTasksRequest], ActivityLiveBgTasksResponse>(
    IPC_CHANNELS.activityListLiveBgTasks,
    (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');

      return {
        chats: getLiveBackgroundTaskSnapshot(
          request.projectId,
          request.worktreeId,
        ),
      };
    },
  );

  registerIpcHandler<[ActivityStartOutputPollingRequest], void>(
    IPC_CHANNELS.activityStartOutputPolling,
    (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.chatId, 'chatId');
      validateTaskId(request.taskId, 'taskId');
      assertAllowedOutputPath(request.outputFile);
      startOutputPolling(request, getWindow);
    },
  );

  registerIpcHandler<[ActivityStopOutputPollingRequest], void>(
    IPC_CHANNELS.activityStopOutputPolling,
    (_event, request) => {
      try {
        if (
          !request ||
          typeof request !== 'object' ||
          typeof request.taskId !== 'string'
        )
          throw new Error('Invalid output polling stop request.');
        validateId(request.projectId, 'projectId');
        validateId(request.worktreeId, 'worktreeId');
        validateId(request.chatId, 'chatId');
        validateTaskId(request.taskId, 'taskId');
      } catch (error) {
        throw classifyError(error, 'input.not_accepted');
      }
      stopOutputPolling(
        request.projectId,
        request.worktreeId,
        request.chatId,
        request.taskId,
      );
    },
  );

  registerIpcHandler<
    [ActivityReadFullOutputRequest],
    ActivityReadFullOutputResponse
  >(IPC_CHANNELS.activityReadFullOutput, async (_event, request) => {
    if (!request.outputFile || typeof request.outputFile !== 'string') {
      return { lines: [], truncated: false };
    }

    const validatedPath = assertAllowedOutputPath(request.outputFile);

    try {
      return await readOutputTail(validatedPath);
    } catch {
      return { lines: [], truncated: false };
    }
  });

  registerIpcHandler<[ActivityReadWorkflowRunRequest], WorkflowRunState | null>(
    IPC_CHANNELS.activityReadWorkflowRun,
    async (_event, request) => {
      if (
        !request.transcriptDir ||
        typeof request.transcriptDir !== 'string' ||
        !request.runId ||
        typeof request.runId !== 'string'
      ) {
        return null;
      }
      validateTaskId(request.runId, 'runId');
      const transcriptDir = assertAllowedWorkflowPath(request.transcriptDir);
      const runStatePath = deriveWorkflowRunStatePath(
        transcriptDir,
        request.runId,
      );
      const validated = assertAllowedWorkflowPath(runStatePath);
      try {
        const raw = await readWorkflowArtifactFile(validated);
        const parsed = parseWorkflowRunState(raw, request.runId);
        if (parsed) {
          return parsed;
        }
      } catch {
        // The completed run-state snapshot is not written until the workflow
        // finishes; fall back to live journal-derived progress below.
      }
      try {
        return await buildLiveWorkflowRun(transcriptDir, request.runId);
      } catch {
        return null;
      }
    },
  );

  registerIpcHandler<
    [ActivityReadWorkflowAgentTranscriptRequest],
    ActivityReadWorkflowAgentTranscriptResponse
  >(
    IPC_CHANNELS.activityReadWorkflowAgentTranscript,
    async (_event, request) => {
      if (
        !request.transcriptDir ||
        typeof request.transcriptDir !== 'string' ||
        !request.agentId ||
        typeof request.agentId !== 'string'
      ) {
        return { lines: [] };
      }
      const transcriptDir = assertAllowedWorkflowPath(request.transcriptDir);
      let agentPath: string;
      try {
        agentPath = deriveWorkflowAgentTranscriptPath(
          transcriptDir,
          request.agentId,
        );
      } catch {
        return { lines: [] };
      }
      const validated = assertAllowedWorkflowPath(agentPath);
      try {
        return await readWorkflowAgentTranscript(validated);
      } catch {
        return { lines: [] };
      }
    },
  );
}
