import { classifyError } from '@canopy/protocol/app-errors/classification';
import { open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { type Stats } from 'node:fs';
import { documentPreviewMaxBytes } from '@canopy/protocol/document-preview';
import { FileSaveConflictError } from '@canopy/protocol/file-save-conflict';
import { FileSaveValidationError } from '@canopy/protocol/file-image-save';
import { createImageFile, decodeImageSave } from '../lib/create-image-file';
import { basename, extname, isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeImage, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  FileDocumentBytesRequest,
  FileDocumentBytesResponse,
  FileContentRequest,
  FileContentResponse,
  FileReferenceResolveRequest,
  FileReferenceResolveResponse,
  FilePreviewRequest,
  FilePreviewResponse,
  OpenExternalFileRequest,
  SaveFileContentRequest,
  SaveFileContentResponse,
  ShowFilesWorkspaceTarget,
  ShowInFinderRequest,
} from '@canopy/desktop-shared/types';
import { getCodexRuntimeService } from '../codex/runtime-service';
import { getFileBrowserRoots } from '../lib/file-browser-roots';
import {
  getAuthorizedFileRoots,
  openAuthorizedRegularFile,
} from '../lib/authorized-file-open';
import { assertExternalFileOpenAllowed } from '../lib/external-file-open';
import { openExternalGuarded } from '../lib/open-external';
import { isPathInside } from '../lib/path-safety';
import {
  getWorktreeAttachmentsDir,
  getWorkspaceWorktreeAttachmentsDir,
  getWorkspaceWorktreeRepoDir,
} from '../lib/paths';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateAbsolutePath, validateId } from '../lib/validation';
import {
  assertPathOutsideSharedContainerReplicas,
  assertWritableScope,
} from '../lib/read-only-scope';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { getWorkspaceType } from '../lib/workspace-registry';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  WORKER_FILESYSTEM_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  classifyFileContentKind,
  fileUrlToAbsolutePath,
  hasGitPathSegment,
  markdownLinkCandidatePath,
} from '@canopy/core-runtime/node';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { toLegacyFileSaveError } from '../canopy-runtime/worker-filesystem-mutation-adapter';
import { canonicalFileContent } from '@canopy/desktop-shared/file-content-projection';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';
import {
  readSharedContainerViewerFile,
  resolveSharedContainerViewerFileForRead,
} from '../shared-containers/read/viewer-root';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import { resolvePortalFileLink } from '../services/files-service';

type FileContentKind = FilePreviewResponse['kind'];

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
]);

/** A queued attachment tile is 24px; 96px covers 2x and 3x displays. */
const VIDEO_FRAME_SIZE = { width: 96, height: 96 };

const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_TEXT_BYTES = 2048;
const MAX_FULL_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_EDIT_TEXT_BYTES = MAX_FULL_TEXT_BYTES;

/** The engine's classification, shared with `worker.filesystem.file.read`. */
function classifyExtension(absolutePath: string): FileContentKind {
  return classifyFileContentKind(absolutePath);
}

function classifyPreviewReadFailure(error: unknown): never {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' ||
      error.code === 'ENOTDIR' ||
      error.code === 'EISDIR')
  ) {
    // Native filesystem errors may come from a different VM realm.
    const message =
      'message' in error && typeof error.message === 'string'
        ? error.message
        : error.code;
    const local = new Error(message);
    Object.defineProperty(local, 'cause', { value: error });
    throw classifyError(local, 'external.state_changed');
  }
  throw error;
}

async function readTextSlice(
  absolutePath: string,
  maxBytes: number,
): Promise<string> {
  const fh = await open(absolutePath, 'r');
  try {
    return await readTextSliceFromHandle(fh, maxBytes);
  } finally {
    await fh.close();
  }
}

async function readTextSliceFromHandle(
  fileHandle: FileHandle,
  maxBytes: number,
): Promise<string> {
  const buffer = Buffer.alloc(maxBytes);
  const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
  const slice = buffer.subarray(0, bytesRead);
  if (slice.includes(0)) {
    return '';
  }
  return slice.toString('utf8');
}

function buildUnsupportedResponse(
  filename: string,
  sizeBytes: number,
  modifiedAtMs: number,
): FilePreviewResponse {
  return {
    kind: 'unsupported',
    content: '',
    filename,
    sizeBytes,
    truncated: false,
    modifiedAtMs,
  };
}

function buildMissingResponse(filename: string): FileContentResponse {
  return {
    kind: 'missing',
    content: '',
    filename,
    sizeBytes: 0,
    truncated: false,
    modifiedAtMs: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isPathInsideRoot(resolvedPath: string, rootPath: string): boolean {
  return (
    resolvedPath === rootPath || resolvedPath.startsWith(`${rootPath}${sep}`)
  );
}

function isWindowsNetworkOrDevicePath(pathValue: string): boolean {
  const windowsPath = pathValue.replace(/\//g, '\\');
  return (
    windowsPath.startsWith('\\\\') ||
    windowsPath.startsWith('\\??\\') ||
    windowsPath.toUpperCase().startsWith('\\GLOBALROOT\\')
  );
}

async function resolveAllowedShowInFinderPath(
  request: ShowInFinderRequest,
): Promise<string> {
  validateAbsolutePath(request.absolutePath, 'absolutePath');
  if (isWindowsNetworkOrDevicePath(request.absolutePath)) {
    throw new Error(
      'Invalid absolutePath: network and device paths are not allowed',
    );
  }

  const { projectId, worktreeId } = request;
  const hasProjectId = projectId !== undefined;
  const hasWorktreeId = worktreeId !== undefined;
  if (hasProjectId !== hasWorktreeId) {
    throw new Error(
      'Invalid file-manager scope: projectId and worktreeId must be provided together',
    );
  }
  if (!hasProjectId || !hasWorktreeId) {
    return request.absolutePath;
  }

  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  const resolvedTarget = await realpath(request.absolutePath);
  const { roots } = await getFileBrowserRoots(projectId, worktreeId);
  for (const root of roots) {
    try {
      const resolvedRoot = await realpath(root.absolutePath);
      if (isPathInside(resolvedRoot, resolvedTarget)) {
        return resolvedTarget;
      }
    } catch {
      // An unavailable optional root cannot authorize the requested target.
    }
  }

  throw new Error(
    'Invalid absolutePath: target must be inside the active worktree',
  );
}

function createFileUrlFromAbsolutePath(pathValue: string): URL {
  return pathToFileURL(pathValue, {
    windows:
      /^[a-zA-Z]:[\\/]/.test(pathValue) ||
      pathValue.startsWith('\\\\') ||
      pathValue.startsWith('//'),
  });
}

// Moved into the `worker.filesystem.link.resolve` engine (CAN-5038).
export { fileUrlToAbsolutePath };

/**
 * The sealed shared-container viewer keeps its no-follow replica reader; it
 * shares only the engine's link-to-path rule.
 */
async function resolveViewerFileReference(
  request: FileReferenceResolveRequest,
): Promise<FileReferenceResolveResponse> {
  const { roots } = await getFileBrowserRoots(
    request.projectId,
    request.worktreeId,
  );
  const resolvedPath = markdownLinkCandidatePath(
    request.baseFilePath,
    request.href,
    roots.map((root) => ({
      id: root.repoId,
      name: root.repoName,
      absolutePath: root.absolutePath,
    })),
  );
  if (!resolvedPath || hasGitPathSegment(resolvedPath)) {
    return null;
  }
  try {
    const resolved = await resolveSharedContainerViewerFileForRead(
      request.worktreeId,
      resolvedPath,
    );
    const info = await getSharedContainerReader().store.lstatEntryForRead(
      resolved.root.revisionRoot,
      resolved.target,
    );
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      return null;
    }
    return {
      absolutePath: resolved.target,
      filename: basename(resolved.target),
      kind: info.isDirectory() ? 'directory' : 'file',
    };
  } catch {
    return null;
  }
}

/**
 * `mode: 'transcript'` (CAN-5038): agent transcript link text matched to one
 * file across the roots, for `IpcCanopyClient`'s `file.resolveLink`. The
 * sealed viewer answers through the Portal resolver's replica branch.
 */
async function resolveTranscriptFileReference(
  dispatcher: FilePreviewDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
  event: IpcMainInvokeEvent,
  request: FileReferenceResolveRequest,
): Promise<FileReferenceResolveResponse> {
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const link = await resolvePortalFileLink(request);
    if (!link) return null;
    const { rootMap } = await getFileBrowserRoots(
      request.projectId,
      request.worktreeId,
    );
    const root = rootMap.get(link.fileRootLocalId);
    if (!root) return null;
    const absolutePath = join(
      root.absolutePath,
      ...link.relativePath.split('/'),
    );
    const filename = basename(absolutePath);
    return {
      absolutePath,
      filename,
      kind: 'file',
      canonical: {
        fileRootId: link.fileRootLocalId,
        relativePath: link.relativePath,
        name: filename,
        kind: 'file',
      },
    };
  }
  const { canonicalResult, legacyResult } =
    await dispatcher.queryLinkResolveForLegacyIpc(
      {
        scope: {
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
        },
        mode: 'transcript',
        href: request.href,
      },
      { caller: resolveCaller(event) },
      { sender: event.sender },
    );
  if (!legacyResult || !canonicalResult) return null;
  return {
    ...legacyResult,
    canonical: {
      fileRootId: canonicalResult.fileRootId,
      relativePath: canonicalResult.relativePath,
      name: canonicalResult.name,
      kind: canonicalResult.kind,
    },
  };
}

/**
 * Markdown links: a projection over `worker.filesystem.link.resolve` on the
 * desktop dispatcher (CAN-5038). Every link failure answers `null`.
 */
async function resolveFileReference(
  dispatcher: FilePreviewDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
  event: IpcMainInvokeEvent,
  request: FileReferenceResolveRequest,
): Promise<FileReferenceResolveResponse> {
  if (request.mode === 'transcript')
    return resolveTranscriptFileReference(
      dispatcher,
      resolveCaller,
      event,
      request,
    );
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
    return resolveViewerFileReference(request);
  const { legacyResult } = await dispatcher.queryLinkResolveForLegacyIpc(
    {
      scope: { workspaceId: request.projectId, worktreeId: request.worktreeId },
      mode: 'markdown',
      href: request.href,
      baseFilePath: request.baseFilePath,
    },
    { caller: resolveCaller(event) },
    { sender: event.sender },
  );
  return legacyResult;
}

async function openWorkspaceDocumentFile(
  request: FileDocumentBytesRequest,
): Promise<{
  absolutePath: string;
  fileHandle: FileHandle;
  fileStat: Stats;
}> {
  validateAbsolutePath(request.absolutePath, 'absolutePath');
  const target = request.workspaceTarget;
  if (!target)
    throw new Error('A project target is required for a scoped file read');
  validateId(target.projectId, 'projectId');
  validateId(target.worktreeId, 'worktreeId');
  const roots = await getAuthorizedFileRoots(target);
  return openAuthorizedRegularFile(request.absolutePath, roots);
}

async function openCodexGeneratedImage(absolutePath: string): Promise<{
  absolutePath: string;
  fileHandle: FileHandle;
  fileStat: Stats;
}> {
  if (isWindowsNetworkOrDevicePath(absolutePath)) {
    throw new Error(
      'Invalid absolutePath: network and device paths are not allowed',
    );
  }

  const { codexHome } = await getCodexRuntimeService().getCanonicalState();
  const generatedImageRoot = join(codexHome, 'generated_images');
  const [resolvedFilePath, resolvedRootPath] = await Promise.all([
    realpath(absolutePath),
    realpath(generatedImageRoot),
  ]);
  if (!isPathInsideRoot(resolvedFilePath, resolvedRootPath)) {
    throw new Error('Cannot read image outside the Codex generated-image root');
  }

  const fileHandle = await open(resolvedFilePath, 'r');
  try {
    const [fileStat, currentPathStat] = await Promise.all([
      fileHandle.stat(),
      stat(resolvedFilePath),
    ]);
    if (!fileStat.isFile()) {
      throw new Error('Cannot read a generated-image path that is not a file');
    }
    if (
      fileStat.dev !== currentPathStat.dev ||
      fileStat.ino !== currentPathStat.ino
    ) {
      throw new Error('Cannot read a file that changed while being validated');
    }
    return { absolutePath: resolvedFilePath, fileHandle, fileStat };
  } catch (error) {
    await fileHandle.close();
    throw error;
  }
}

async function buildAllowedSaveRoots(
  projectId: string,
  worktreeId: string,
): Promise<string[]> {
  const workspaceType = getWorkspaceType(projectId);
  if (workspaceType === 'multi-repo') {
    const config = await readWorkspaceConfig(projectId);
    const roots: string[] = [
      resolveWorktreeCwd(projectId, worktreeId),
      ...config.repos.map((repo) =>
        getWorkspaceWorktreeRepoDir(projectId, worktreeId, repo.id),
      ),
    ];
    roots.push(getWorkspaceWorktreeAttachmentsDir(projectId, worktreeId));
    return roots;
  }

  return [
    resolveWorktreeCwd(projectId, worktreeId),
    getWorktreeAttachmentsDir(projectId, worktreeId),
  ];
}

async function ensureFileIsWithinAllowedRoots(
  absolutePath: string,
  allowedRoots: string[],
): Promise<string> {
  let resolvedFilePath: string;
  try {
    resolvedFilePath = await realpath(absolutePath);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      throw new Error(`Cannot save non-existent file: ${absolutePath}`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  for (const rootPath of allowedRoots) {
    let resolvedRootPath: string;
    try {
      resolvedRootPath = await realpath(rootPath);
    } catch {
      continue;
    }

    if (isPathInsideRoot(resolvedFilePath, resolvedRootPath)) {
      return resolvedFilePath;
    }
  }

  throw new Error(`Cannot save file outside allowed worktree roots`);
}

async function readImageContent(
  absolutePath: string,
  filename: string,
  sizeBytes: number,
  modifiedAtMs: number,
  fileHandle?: FileHandle,
): Promise<FilePreviewResponse> {
  const extension = extname(absolutePath).toLowerCase();
  if (sizeBytes > MAX_IMAGE_BYTES) {
    return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
  }
  const data = fileHandle
    ? await fileHandle.readFile()
    : await readFile(absolutePath);
  const mime = IMAGE_MIME_MAP[extension] ?? 'application/octet-stream';
  const dataUrl = `data:${mime};base64,${data.toString('base64')}`;
  return {
    kind: 'image',
    content: dataUrl,
    filename,
    sizeBytes,
    truncated: false,
    modifiedAtMs,
  };
}

/**
 * A video's first frame as an image, from the operating system's thumbnailer
 * (QuickLook on macOS, the shell thumbnail cache on Windows). Linux has none,
 * and a file the OS cannot thumbnail stays unsupported.
 */
async function readVideoFrame(
  absolutePath: string,
  filename: string,
  sizeBytes: number,
  modifiedAtMs: number,
): Promise<FilePreviewResponse> {
  try {
    const image = await nativeImage.createThumbnailFromPath(
      absolutePath,
      VIDEO_FRAME_SIZE,
    );
    if (image.isEmpty()) {
      return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
    }
    return {
      kind: 'image',
      content: image.toDataURL(),
      filename,
      sizeBytes,
      truncated: false,
      modifiedAtMs,
    };
  } catch {
    return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
  }
}

async function readTextContent(
  absolutePath: string,
  filename: string,
  sizeBytes: number,
  modifiedAtMs: number,
  kind: 'text' | 'markdown' | 'html',
  maxBytes: number,
  fileHandle?: FileHandle,
): Promise<FilePreviewResponse> {
  const text = fileHandle
    ? await readTextSliceFromHandle(fileHandle, maxBytes)
    : await readTextSlice(absolutePath, maxBytes);
  if (text === '' && sizeBytes > 0) {
    return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
  }
  return {
    kind,
    content: text,
    filename,
    sizeBytes,
    truncated: sizeBytes > maxBytes,
    modifiedAtMs,
  };
}

async function readViewerFileContent(
  request: FileContentRequest,
): Promise<FileContentResponse> {
  const opened = await readSharedContainerViewerFile(
    request.workspaceTarget?.worktreeId ?? '',
    request.absolutePath,
  );
  const kind = classifyExtension(request.absolutePath);
  if (kind === 'unsupported') {
    return buildUnsupportedResponse(
      opened.filename,
      opened.sizeBytes,
      opened.modifiedAtMs,
    );
  }
  if (kind === 'image') {
    if (opened.sizeBytes > MAX_IMAGE_BYTES) {
      return buildUnsupportedResponse(
        opened.filename,
        opened.sizeBytes,
        opened.modifiedAtMs,
      );
    }
    const mime =
      IMAGE_MIME_MAP[extname(request.absolutePath).toLowerCase()] ??
      'application/octet-stream';
    return {
      kind: 'image',
      content: `data:${mime};base64,${opened.bytes.toString('base64')}`,
      filename: opened.filename,
      sizeBytes: opened.sizeBytes,
      truncated: false,
      modifiedAtMs: opened.modifiedAtMs,
    };
  }
  const slice = opened.bytes.subarray(0, MAX_FULL_TEXT_BYTES);
  if (slice.includes(0)) {
    return buildUnsupportedResponse(
      opened.filename,
      opened.sizeBytes,
      opened.modifiedAtMs,
    );
  }
  return {
    kind,
    content: slice.toString('utf8'),
    filename: opened.filename,
    sizeBytes: opened.sizeBytes,
    truncated: opened.sizeBytes > MAX_FULL_TEXT_BYTES,
    modifiedAtMs: opened.modifiedAtMs,
  };
}

/** The legacy text of a canonical read failure: its runtime cause, as before. */
function rethrowLegacyFileReadError(error: unknown): never {
  if (error instanceof CanopyOperationError) {
    if (error.runtimeCause instanceof Error) throw error.runtimeCause;
    throw new Error(error.payload.message);
  }
  throw error;
}

type FilePreviewDispatcher = Pick<
  DesktopCanopyDispatcher,
  | 'queryFileContentForLegacyIpc'
  | 'queryLinkResolveForLegacyIpc'
  | 'saveTextFileForLegacyIpc'
>;

/**
 * The scoped workspace branch: a projection over
 * `worker.filesystem.file.read` on the desktop dispatcher (CAN-4099).
 */
async function readScopedFileContent(
  dispatcher: FilePreviewDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
  event: IpcMainInvokeEvent,
  request: FileContentRequest,
  target: ShowFilesWorkspaceTarget,
): Promise<FileContentResponse> {
  validateId(target.projectId, 'projectId');
  validateId(target.worktreeId, 'worktreeId');
  try {
    const { canonicalResult, legacyResult } =
      await dispatcher.queryFileContentForLegacyIpc(
        {
          scope: {
            workspaceId: target.projectId,
            worktreeId: target.worktreeId,
          },
          absolutePath: request.absolutePath,
          ...(request.file && {
            file: {
              fileRootId: request.file.fileRootId,
              relativePath: request.file.relativePath,
            },
          }),
        },
        { caller: resolveCaller(event) },
        { sender: event.sender },
      );
    return request.file && canonicalResult
      ? { ...legacyResult, canonical: canonicalFileContent(canonicalResult) }
      : legacyResult;
  } catch (error) {
    return rethrowLegacyFileReadError(error);
  }
}

/** `fileReadContent`'s read of a plain absolute path, for callers in main. */
export async function readLocalFileContent(
  absolutePath: string,
): Promise<FileContentResponse> {
  let fileStat: Stats;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT')
      return buildMissingResponse(basename(absolutePath));
    throw error;
  }
  const filename = basename(absolutePath);
  const kind = classifyExtension(absolutePath);
  if (kind === 'unsupported')
    return buildUnsupportedResponse(filename, fileStat.size, fileStat.mtimeMs);
  if (kind === 'image')
    return readImageContent(
      absolutePath,
      filename,
      fileStat.size,
      fileStat.mtimeMs,
    );
  return readTextContent(
    absolutePath,
    filename,
    fileStat.size,
    fileStat.mtimeMs,
    kind,
    MAX_FULL_TEXT_BYTES,
  );
}

export function registerFilePreviewHandlers(
  dispatcher: FilePreviewDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  registerIpcHandler(
    IPC_CHANNELS.fileReferenceResolve,
    async (
      event,
      request: FileReferenceResolveRequest,
    ): Promise<FileReferenceResolveResponse> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return resolveFileReference(dispatcher, resolveCaller, event, request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileShowInFinder,
    async (_event, request: ShowInFinderRequest): Promise<void> => {
      if (request.projectId) assertWritableScope(request.projectId);
      await assertPathOutsideSharedContainerReplicas(request.absolutePath);
      const allowedPath = await resolveAllowedShowInFinderPath(request);
      shell.showItemInFolder(allowedPath);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileOpenExternal,
    async (_event, request: OpenExternalFileRequest): Promise<void> => {
      await assertExternalFileOpenAllowed(request);
      const fileUrl = createFileUrlFromAbsolutePath(request.absolutePath);
      await openExternalGuarded(fileUrl.toString());
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileReadPreview,
    async (
      _event,
      request: FilePreviewRequest,
    ): Promise<FilePreviewResponse> => {
      if (
        !request ||
        typeof request.absolutePath !== 'string' ||
        !isAbsolute(request.absolutePath)
      )
        throw classifyError(
          new Error('Invalid absolutePath: must be an absolute path'),
          'input.not_accepted',
        );
      const fileStat = await stat(request.absolutePath).catch(
        classifyPreviewReadFailure,
      );
      const sizeBytes = fileStat.size;
      const modifiedAtMs = fileStat.mtimeMs;
      const filename = basename(request.absolutePath);
      if (
        request.videoFrame === true &&
        VIDEO_EXTENSIONS.has(extname(request.absolutePath).toLowerCase())
      ) {
        return readVideoFrame(
          request.absolutePath,
          filename,
          sizeBytes,
          modifiedAtMs,
        );
      }
      const kind = classifyExtension(request.absolutePath);

      if (kind === 'unsupported') {
        return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
      }

      if (kind === 'image') {
        return readImageContent(
          request.absolutePath,
          filename,
          sizeBytes,
          modifiedAtMs,
        ).catch(classifyPreviewReadFailure);
      }

      return readTextContent(
        request.absolutePath,
        filename,
        sizeBytes,
        modifiedAtMs,
        kind,
        MAX_PREVIEW_TEXT_BYTES,
      ).catch(classifyPreviewReadFailure);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileReadDocumentBytes,
    async (
      _event,
      request: FileDocumentBytesRequest,
    ): Promise<FileDocumentBytesResponse> => {
      const maxBytes = documentPreviewMaxBytes(request.absolutePath);
      if (
        request.workspaceTarget?.projectId ===
        SHARED_CONTAINER_VIEWER_PROJECT_ID
      ) {
        try {
          const opened = await readSharedContainerViewerFile(
            request.workspaceTarget.worktreeId,
            request.absolutePath,
          );
          if (opened.sizeBytes > maxBytes) {
            return {
              status: 'too-large',
              maxBytes,
              sizeBytes: opened.sizeBytes,
            };
          }
          return {
            status: 'ready',
            bytes: Uint8Array.from(opened.bytes),
            filename: opened.filename,
            sizeBytes: opened.sizeBytes,
            modifiedAtMs: opened.modifiedAtMs,
          };
        } catch (error) {
          if (getErrorCode(error) === 'ENOENT') return { status: 'missing' };
          throw error;
        }
      }
      let fileHandle: FileHandle | undefined;
      try {
        const opened = await openWorkspaceDocumentFile(request);
        fileHandle = opened.fileHandle;
        const { absolutePath, fileStat } = opened;
        if (fileStat.size > maxBytes) {
          return {
            status: 'too-large',
            maxBytes,
            sizeBytes: fileStat.size,
          };
        }
        const chunks: Uint8Array[] = [];
        let sizeBytes = 0;
        while (sizeBytes <= maxBytes) {
          const buffer = Buffer.allocUnsafe(
            Math.min(64 * 1024, maxBytes + 1 - sizeBytes),
          );
          const { bytesRead } = await fileHandle.read(
            buffer,
            0,
            buffer.byteLength,
            sizeBytes,
          );
          if (bytesRead === 0) break;
          sizeBytes += bytesRead;
          if (sizeBytes > maxBytes) {
            // This is the observed lower bound, not the stale stat size.
            return {
              status: 'too-large',
              maxBytes,
              sizeBytes,
            };
          }
          // Trim short reads so retained capacity is bounded by bytes read,
          // even when a growing file repeatedly yields tiny chunks.
          chunks.push(
            bytesRead === buffer.byteLength
              ? buffer
              : new Uint8Array(buffer.subarray(0, bytesRead)),
          );
        }
        // Exact backing-store size; never expose unused pooled Buffer bytes.
        const bytes = new Uint8Array(sizeBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          status: 'ready',
          bytes,
          filename: basename(absolutePath),
          sizeBytes,
          modifiedAtMs: fileStat.mtimeMs,
        };
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') return { status: 'missing' };
        throw error;
      } finally {
        await fileHandle?.close();
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileReadContent,
    async (
      event,
      request: FileContentRequest,
    ): Promise<FileContentResponse> => {
      validateAbsolutePath(request.absolutePath, 'absolutePath');
      if (
        request.workspaceTarget?.projectId ===
        SHARED_CONTAINER_VIEWER_PROJECT_ID
      ) {
        try {
          return await readViewerFileContent(request);
        } catch (error) {
          if (getErrorCode(error) === 'ENOENT') {
            return buildMissingResponse(basename(request.absolutePath));
          }
          throw error;
        }
      }
      if (
        request.allowedRoot !== 'codex-generated-images' &&
        request.workspaceTarget
      ) {
        return readScopedFileContent(
          dispatcher,
          resolveCaller,
          event,
          request,
          request.workspaceTarget,
        );
      }
      let absolutePath = request.absolutePath;
      let fileHandle: FileHandle | undefined;
      let fileStat: Stats;
      try {
        if (request.allowedRoot === 'codex-generated-images') {
          const opened = await openCodexGeneratedImage(request.absolutePath);
          absolutePath = opened.absolutePath;
          fileHandle = opened.fileHandle;
          fileStat = opened.fileStat;
        } else {
          fileStat = await stat(absolutePath);
        }
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return buildMissingResponse(basename(absolutePath));
        }
        throw error;
      }

      try {
        const filename = basename(absolutePath);
        const sizeBytes = fileStat.size;
        const modifiedAtMs = fileStat.mtimeMs;
        const kind = classifyExtension(absolutePath);

        if (kind === 'unsupported') {
          return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
        }

        if (kind === 'image') {
          return await readImageContent(
            absolutePath,
            filename,
            sizeBytes,
            modifiedAtMs,
            fileHandle,
          );
        }

        return await readTextContent(
          absolutePath,
          filename,
          sizeBytes,
          modifiedAtMs,
          kind,
          MAX_FULL_TEXT_BYTES,
          fileHandle,
        );
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return buildMissingResponse(basename(absolutePath));
        }
        throw error;
      } finally {
        await fileHandle?.close();
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileSaveContent,
    async (
      event,
      request: SaveFileContentRequest,
    ): Promise<SaveFileContentResponse> => {
      const { withWorkspaceTargetRuntimeStartReservation } =
        await import('../lib/workspace-target-exclusion');
      return withWorkspaceTargetRuntimeStartReservation(
        request.projectId,
        request.worktreeId,
        async () => {
          validateId(request.projectId, 'projectId');
          validateId(request.worktreeId, 'worktreeId');
          assertWritableScope(request.projectId);
          validateAbsolutePath(request.absolutePath, 'absolutePath');

          if (request.createOnly === true || request.encoding === 'base64') {
            const bytes = decodeImageSave(request);
            const roots = await buildAllowedSaveRoots(
              request.projectId,
              request.worktreeId,
            );
            const { touchWorkspaceTarget } =
              await import('../lib/workspace-activity');
            return createImageFile(request, bytes, roots, () =>
              touchWorkspaceTarget(request.projectId, request.worktreeId),
            );
          }
          if (
            (request.encoding !== undefined && request.encoding !== 'utf8') ||
            (request.createOnly !== undefined && request.createOnly !== false)
          ) {
            throw new FileSaveValidationError('Invalid file save options.');
          }

          const kind = classifyExtension(request.absolutePath);
          if (kind === 'image' || kind === 'unsupported') {
            throw new Error('Only text-based files can be edited');
          }

          if (
            Buffer.byteLength(request.content, 'utf8') > MAX_EDIT_TEXT_BYTES
          ) {
            throw new Error('File content exceeds the 5 MB save limit');
          }

          if (request.content.includes('\0')) {
            throw new Error('File content cannot contain null bytes');
          }

          let caller: CanopyCallerDescriptor;
          try {
            caller = resolveCaller(event);
          } catch (error) {
            throw toLegacyFileSaveError(error);
          }
          const allowedRoots = await buildAllowedSaveRoots(
            request.projectId,
            request.worktreeId,
          );
          const resolvedSavePath = await ensureFileIsWithinAllowedRoots(
            request.absolutePath,
            allowedRoots,
          );

          const currentStat = await stat(resolvedSavePath);
          // `NaN` (a preview without `modifiedAt`) saves unconditionally.
          if (
            typeof request.expectedModifiedAtMs === 'number' &&
            Math.abs(currentStat.mtimeMs - request.expectedModifiedAtMs) > 1
          ) {
            throw new FileSaveConflictError();
          }

          // The instruction compares the exact version of the stat this
          // check accepted, never one built from the renderer's stamp.
          const saved = await dispatcher.saveTextFileForLegacyIpc(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              realPath: resolvedSavePath,
              content: request.content,
              expectedVersion: `${currentStat.size}:${Math.round(currentStat.mtimeMs)}`,
            },
            {
              caller: { ...caller, grants: [WORKER_FILESYSTEM_GRANTS.write] },
            },
          );
          if (saved === 'unrouted') {
            // Save-only roots, unresolved managed targets, unreadable roots
            // and POSIX names the write path check refuses keep the direct
            // write (CAN-4100 debt).
            const { touchWorkspaceTarget } =
              await import('../lib/workspace-activity');
            await touchWorkspaceTarget(request.projectId, request.worktreeId);
            await writeFile(resolvedSavePath, request.content, 'utf8');
          }
          // Stat after the write, as before: the renderer's next stamp.
          const savedStat = await stat(resolvedSavePath);
          return {
            filename: basename(request.absolutePath),
            sizeBytes: savedStat.size,
            modifiedAtMs: savedStat.mtimeMs,
          };
        },
      );
    },
  );
}
