import { classifyError } from '@canopy/protocol/app-errors/classification';
import { IdentifierValidationError } from '../lib/identifier-validation-error';
import type { IpcMainInvokeEvent } from 'electron';
import { DESKTOP_FILE_IMAGE_SAVE_SUPPORT } from '@canopy/protocol/file-image-save';
import { posix, resolve, sep, win32 } from 'node:path';
import {
  WORKER_FILESYSTEM_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyStreamCursor,
  type WorkerFilesystemRootsListResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { allocateAttachmentsRootId } from '@canopy/core-runtime/node';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type FileTreeChangeEvent,
  type FileIndexRequest,
  type FileIndexResponse,
  type FileTreeDirectoryRequest,
  type FileTreeDirectoryResponse,
  type FileTreeMutationRequest,
  type FileTreeMutationResponse,
  type FileTreeRootsRequest,
  type FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { toLegacyFileTreeMutationError } from '../canopy-runtime/worker-filesystem-mutation-adapter';
import { PortalServiceError } from '../services/portal-service-error';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';
import { validateId } from '../lib/validation';
import { isWritableScope } from '../lib/read-only-scope';

export type DesktopIpcCallerResolver = (
  event: IpcMainInvokeEvent,
) => CanopyCallerDescriptor;

function rethrowLegacyFileTreeError(error: unknown): never {
  if (error instanceof CanopyOperationError) {
    if (error.runtimeCause instanceof Error) {
      throw error.runtimeCause;
    }
    throw new Error(error.payload.message);
  }
  throw error;
}

const FILE_TREE_CHANGE_DEBOUNCE_MS = 120;

type FileTreeWatchSender = IpcMainInvokeEvent['sender'];

type FileTreeWatchHandle = Awaited<
  ReturnType<DesktopCanopyDispatcher['openFileTreeWatchForLegacyIpc']>
>['handle'];

/** One renderer's watch of one worktree, across one stream per watched root. */
interface FileTreeWatchEntry {
  closed: boolean;
  handles: Set<FileTreeWatchHandle>;
  timer: ReturnType<typeof setTimeout> | null;
  changeCount: number;
  /** Cursors already counted; a nested root repeats its outer root's items. */
  counted: Set<string>;
}

function closeFileTreeWatch(entry: FileTreeWatchEntry): void {
  entry.closed = true;
  for (const handle of Array.from(entry.handles)) handle.close();
  entry.handles.clear();
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  return candidate.startsWith(
    parent.endsWith(sep) ? parent : `${parent}${sep}`,
  );
}

/**
 * Roots to stream: every listed root not nested inside another (one recursive
 * native watch covers them), plus the attachments root while it is hidden, so
 * its first file still reaches the explorer.
 */
function fileTreeWatchRootIds(
  canonical: WorkerFilesystemRootsListResult,
  legacy: FileTreeRootsResponse,
): { rootIds: string[]; hiddenAttachmentsRootId: string | null } {
  const rootPaths = resolveLegacyRootPaths(legacy);
  const roots = canonical.roots
    .map((root) => ({
      fileRootId: root.fileRootId,
      path: resolve(requireLegacyRootPath(rootPaths, root.fileRootId)),
    }))
    .sort((left, right) => left.path.length - right.path.length);
  const outermost = roots.filter(
    (root, index) =>
      !roots
        .slice(0, index)
        .some(
          (parent) =>
            parent.path === root.path || isPathInside(parent.path, root.path),
        ),
  );
  return {
    rootIds: outermost.map((root) => root.fileRootId),
    hiddenAttachmentsRootId: canonical.roots.some(
      (root) => root.kind === 'attachments',
    )
      ? null
      : allocateAttachmentsRootId(
          new Set(canonical.roots.map((root) => root.fileRootId)),
        ),
  };
}

function cursorKey(cursor: CanopyStreamCursor): string {
  return `${cursor.daemonEpoch}:${cursor.sequence}`;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError && error.payload.kind === 'not_found'
  );
}

/** Counts each change once and sends one event per 120 ms window. */
function countFileTreeChange(
  entry: FileTreeWatchEntry,
  cursor: CanopyStreamCursor,
  eventCount: number,
  onChange: (changeCount: number) => void,
): void {
  const key = cursorKey(cursor);
  if (entry.closed || entry.counted.has(key)) return;
  entry.counted.add(key);
  entry.changeCount += eventCount;
  entry.timer ??= setTimeout(() => {
    entry.timer = null;
    const changeCount = entry.changeCount;
    entry.changeCount = 0;
    entry.counted.clear();
    if (!entry.closed) onChange(changeCount);
  }, FILE_TREE_CHANGE_DEBOUNCE_MS);
}

/**
 * Opens one in-process stream per watched root and resolves once every
 * native handle is attached. A failure closes the whole entry's streams.
 */
async function openFileTreeWatchStreams(
  dispatcher: DesktopCanopyDispatcher,
  entry: FileTreeWatchEntry,
  request: FileTreeRootsRequest,
  caller: CanopyCallerDescriptor,
  onChange: (changeCount: number) => void,
): Promise<void> {
  const scope = {
    workspaceId: request.projectId,
    worktreeId: request.worktreeId,
  };
  async function openRoot(
    fileRootId: string,
    mayBeAbsent: boolean,
  ): Promise<void> {
    const opened = await dispatcher.openFileTreeWatchForLegacyIpc(
      { scope, fileRootId },
      {
        caller,
        onFrame: (frame): void => {
          if (frame.kind === 'item')
            countFileTreeChange(
              entry,
              frame.cursor,
              frame.item.eventCount ?? 1,
              onChange,
            );
        },
      },
    );
    if (entry.closed) {
      opened.handle.close();
      return;
    }
    entry.handles.add(opened.handle);
    try {
      await opened.attached;
    } catch (error) {
      if (entry.closed) return;
      // A scope without an attachments directory has no attachments root.
      if (mayBeAbsent && isNotFound(error)) {
        entry.handles.delete(opened.handle);
        return;
      }
      throw error;
    }
  }
  // The viewer's replica has no native watch (the worker keeps it inert), and
  // reading its roots could fail a start that never needed them.
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) return;
  // Read directly, never through the daemon route: this stream has no
  // daemon registration yet (CAN-4730).
  const roots = await dispatcher.queryFileTreeRootsForLegacyIpc(
    { scope },
    { caller },
  );
  if (entry.closed) return;
  const watched = fileTreeWatchRootIds(
    roots.canonicalResult,
    roots.legacyResult,
  );
  await Promise.all([
    ...watched.rootIds.map((fileRootId) => openRoot(fileRootId, false)),
    ...(watched.hiddenAttachmentsRootId === null
      ? []
      : [openRoot(watched.hiddenAttachmentsRootId, true)]),
  ]);
}

function resolveLegacyRootPaths(
  response: FileTreeRootsResponse,
): ReadonlyMap<string, string> {
  const { roots } = response;
  return new Map(roots.map((root) => [root.repoId, root.absolutePath]));
}

function requireLegacyRootPath(
  rootPaths: ReadonlyMap<string, string>,
  fileRootId: string,
): string {
  const rootPath = rootPaths.get(fileRootId);
  if (rootPath === undefined) {
    throw new Error(`Unable to resolve local file root: ${fileRootId}`);
  }
  return rootPath;
}

function requireLegacyEntryPath(
  legacyEntries: ReadonlyMap<string, string>,
  relativePath: string,
): string {
  const isWindows = process.platform === 'win32';
  const normalizedInput = isWindows
    ? relativePath.replace(/\\/g, '/')
    : relativePath;
  if (
    (isWindows && win32.isAbsolute(relativePath)) ||
    posix.isAbsolute(normalizedInput) ||
    normalizedInput.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('Invalid canonical file-tree relative path.');
  }
  const absolutePath = legacyEntries.get(relativePath);
  if (absolutePath === undefined) {
    throw new Error(`Unable to resolve local file-tree entry: ${relativePath}`);
  }
  return absolutePath;
}

function isCreateRequest(
  request: FileTreeMutationRequest | null | undefined,
): request is Extract<
  FileTreeMutationRequest,
  { operation: 'create-file' | 'create-directory' }
> {
  return (
    request?.operation === 'create-file' ||
    request?.operation === 'create-directory'
  );
}

function isTransferRequest(
  request: FileTreeMutationRequest | null | undefined,
): request is Extract<FileTreeMutationRequest, { operation: 'copy' | 'move' }> {
  return request?.operation === 'copy' || request?.operation === 'move';
}

export function registerFileTreeHandlers(
  dispatcher: DesktopCanopyDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  registerIpcHandler<[FileIndexRequest], FileIndexResponse>(
    IPC_CHANNELS.fileIndexGet,
    async (event, request) => {
      if (!request || typeof request !== 'object')
        throw classifyError(
          new Error('Expected a file-index request.'),
          'input.not_accepted',
        );
      try {
        validateId(request.projectId, 'projectId');
        validateId(request.worktreeId, 'worktreeId');
      } catch (error) {
        if (error instanceof IdentifierValidationError)
          throw classifyError(error, 'input.not_accepted');
        throw error;
      }
      try {
        return await dispatcher.queryFileIndexForLegacyIpc(
          request,
          { caller: resolveCaller(event) },
          { sender: event.sender },
        );
      } catch (error) {
        if (error instanceof CanopyOperationError) {
          const { code, message } = error.payload;
          if (
            code === 'worker.filesystem.roots.notFound' ||
            code === 'worker.filesystem.roots.revisionConflict' ||
            code === 'worker.filesystem.search.notFound' ||
            code === 'worker.filesystem.search.revisionConflict'
          ) {
            const legacy =
              error.runtimeCause instanceof Error
                ? error.runtimeCause
                : new Error(message);
            throw classifyError(legacy, 'external.state_changed');
          }
        }
        return rethrowLegacyFileTreeError(error);
      }
    },
  );

  registerIpcHandler<[FileTreeRootsRequest], FileTreeRootsResponse>(
    IPC_CHANNELS.fileTreeRoots,
    async (event, request) => {
      try {
        const { canonicalResult, legacyResult } =
          await dispatcher.queryFileTreeRootsForLegacyIpc(
            {
              scope: {
                workspaceId: request.projectId,
                worktreeId: request.worktreeId,
              },
            },
            { caller: resolveCaller(event) },
            { sender: event.sender },
          );
        const rootPaths = resolveLegacyRootPaths(legacyResult);
        return {
          ...(isWritableScope(request.projectId)
            ? { imageSaveSupport: DESKTOP_FILE_IMAGE_SAVE_SUPPORT }
            : {}),
          roots: canonicalResult.roots.map((root) => ({
            repoId: root.fileRootId,
            repoName: root.name,
            absolutePath: requireLegacyRootPath(rootPaths, root.fileRootId),
            rootKind: root.kind,
          })),
        };
      } catch (error) {
        return rethrowLegacyFileTreeError(error);
      }
    },
  );

  registerIpcHandler<[FileTreeDirectoryRequest], FileTreeDirectoryResponse>(
    IPC_CHANNELS.fileTreeDirectory,
    async (event, request) => {
      try {
        const { canonicalResult, legacyResult } =
          await dispatcher.queryFileTreeDirectoryForLegacyIpc(
            {
              scope: {
                workspaceId: request.projectId,
                worktreeId: request.worktreeId,
              },
              fileRootId: request.repoId,
              relativePath: request.relativeDir,
            },
            { caller: resolveCaller(event) },
            { sender: event.sender },
          );
        const legacyEntryPaths = new Map(
          legacyResult.entries.map((entry) => [
            entry.relativePath,
            entry.absolutePath,
          ]),
        );
        return {
          entries: canonicalResult.entries.map((entry) => ({
            name: entry.name,
            relativePath: entry.relativePath,
            absolutePath: requireLegacyEntryPath(
              legacyEntryPaths,
              entry.relativePath,
            ),
            kind: entry.kind,
            isIgnored: entry.isIgnored,
            isIndexExcluded: entry.isIndexExcluded,
            isSymlink: entry.isSymlink,
            hasChildren: entry.hasChildren,
          })),
        };
      } catch (error) {
        return rethrowLegacyFileTreeError(error);
      }
    },
  );

  registerIpcHandler<[FileTreeMutationRequest], FileTreeMutationResponse>(
    IPC_CHANNELS.fileTreeMutate,
    async (event, request) => {
      if (isTransferRequest(request)) {
        validateId(request.projectId, 'projectId');
        validateId(request.worktreeId, 'worktreeId');
        try {
          const caller = resolveCaller(event);
          return await dispatcher.transferFileTreeEntryForLegacyIpc(request, {
            caller: { ...caller, grants: [WORKER_FILESYSTEM_GRANTS.write] },
          });
        } catch (error) {
          throw toLegacyFileTreeMutationError(error);
        }
      }
      if (isCreateRequest(request)) {
        validateId(request.projectId, 'projectId');
        validateId(request.worktreeId, 'worktreeId');
        try {
          const caller = resolveCaller(event);
          return await dispatcher.createFileTreeEntryForLegacyIpc(request, {
            caller: { ...caller, grants: [WORKER_FILESYSTEM_GRANTS.write] },
          });
        } catch (error) {
          throw toLegacyFileTreeMutationError(error);
        }
      }
      if (request?.operation !== 'delete')
        throw new PortalServiceError(
          'invalid_payload',
          'Unsupported file-tree mutation operation.',
        );
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      try {
        const caller = resolveCaller(event);
        return await dispatcher.deleteFileTreeEntryForLegacyIpc(request, {
          caller: { ...caller, grants: [WORKER_FILESYSTEM_GRANTS.write] },
        });
      } catch (error) {
        throw toLegacyFileTreeMutationError(error);
      }
    },
  );

  const fileTreeWatches = new Map<string, FileTreeWatchEntry>();
  const fileTreeTeardownSenders = new Set<number>();
  const watchKey = (ownerId: number, request: FileTreeRootsRequest): string =>
    `${ownerId}:${request.projectId}/${request.worktreeId}`;
  const stopWatch = (key: string): void => {
    const entry = fileTreeWatches.get(key);
    if (!entry) return;
    fileTreeWatches.delete(key);
    closeFileTreeWatch(entry);
  };
  const ensureSenderTeardown = (sender: FileTreeWatchSender): void => {
    const ownerId = sender.id;
    if (fileTreeTeardownSenders.has(ownerId)) return;
    fileTreeTeardownSenders.add(ownerId);
    sender.once('destroyed', () => {
      fileTreeTeardownSenders.delete(ownerId);
      const prefix = `${ownerId}:`;
      for (const key of Array.from(fileTreeWatches.keys()))
        if (key.startsWith(prefix)) stopWatch(key);
    });
  };

  registerIpcHandler<[FileTreeRootsRequest], void>(
    IPC_CHANNELS.fileTreeWatchStart,
    async (event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      const caller = resolveCaller(event);
      const { sender } = event;
      const key = watchKey(sender.id, request);
      stopWatch(key);
      // Registered synchronously, so a stop that arrives mid-start closes it.
      const entry: FileTreeWatchEntry = {
        closed: false,
        handles: new Set(),
        timer: null,
        changeCount: 0,
        counted: new Set(),
      };
      fileTreeWatches.set(key, entry);
      ensureSenderTeardown(sender);
      try {
        await openFileTreeWatchStreams(
          dispatcher,
          entry,
          request,
          caller,
          (changeCount) => {
            if (sender.isDestroyed()) return;
            const changeEvent: FileTreeChangeEvent = {
              ...request,
              changeCount,
            };
            sendToWebContents(
              sender,
              IPC_CHANNELS.fileTreeChanged,
              changeEvent,
            );
          },
        );
      } catch (error) {
        if (fileTreeWatches.get(key) === entry) fileTreeWatches.delete(key);
        closeFileTreeWatch(entry);
        return rethrowLegacyFileTreeError(error);
      }
    },
  );

  registerIpcHandler<[FileTreeRootsRequest], void>(
    IPC_CHANNELS.fileTreeWatchStop,
    (event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      stopWatch(watchKey(event.sender.id, request));
    },
  );
}
