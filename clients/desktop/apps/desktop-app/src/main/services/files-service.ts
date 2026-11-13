import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, sep } from 'node:path';
import type {
  FileContentRequest,
  FileIndexRequest,
  FileIndexResponse,
  FileTreeDirectoryRequest,
  FileTreeDirectoryResponse,
  FileTreeRoot,
  FileTreeRootsRequest,
  FileTreeRootsResponse,
  PortalDirectoryListing,
  PortalFileReadPayload,
  PortalFileLinkResolvePayload,
  PortalFileLinkResolution,
  PortalFilePreview,
  PortalFileRoot,
  PortalFileSavePayload,
  PortalFileSnapshotPayload,
} from '@canopy/desktop-shared/types';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  getFileBrowserRoots,
  type FileBrowserRoot,
} from '../lib/file-browser-roots';
import {
  buildFileExplorerGlobMatcher,
  buildFileGlobMatcher,
} from '../lib/file-glob-matcher';
import {
  buildFileIndexResult,
  listDirectory as listFilesystemDirectory,
  type FileSystemReadBoundary,
} from '../lib/file-system-listing';
import { readPreferencesFile } from '../lib/preferences-store';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { normalizeFileTreeRelativePath as normalizeRelativePath } from './file-tree-relative-path';
import { assertWritableScope } from '../lib/read-only-scope';
import { PortalServiceError } from './portal-service-error';
import {
  readSharedContainerViewerFile,
  resolveSharedContainerViewerFileForRead,
} from '../shared-containers/read/viewer-root';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  decodeTranscriptLink,
  resolveFilesystemLink,
} from '@canopy/core-runtime/node';

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_SAVE_BYTES = 5 * 1024 * 1024;

/** The sealed-replica no-follow reads for a shared-container viewer root. */
export function readBoundaryForRoot(
  root: FileBrowserRoot,
): FileSystemReadBoundary | undefined {
  if (!root.readBoundaryRoot) return undefined;
  const store = getSharedContainerReader().store;
  const revisionRoot = root.readBoundaryRoot;
  return {
    assertDirectory: (_listingRoot, target) =>
      store.assertRealDirectoryForRead(revisionRoot, target),
    readDirectory: (_listingRoot, target) =>
      store.readDirectoryForRead(revisionRoot, target),
    lstatEntry: (_listingRoot, target) =>
      store.lstatEntryForRead(revisionRoot, target),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isPathInsideRoot(pathValue: string, rootPath: string): boolean {
  return pathValue === rootPath || pathValue.startsWith(`${rootPath}${sep}`);
}

/**
 * Resolve an agent transcript link without exposing an unbounded file path.
 * The Portal keeps this direct path (CAN-5038 records it); outside the
 * sealed viewer it calls the `worker.filesystem.link.resolve` engine as a
 * library, in `transcript` mode, and answers every link failure as `null`.
 */
export async function resolvePortalFileLink(
  request: PortalFileLinkResolvePayload,
): Promise<PortalFileLinkResolution | null> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const link = decodeTranscriptLink(request.href);
  if (!link.ok) return null;
  const { roots } = await getFileBrowserRoots(
    request.projectId,
    request.worktreeId,
  );

  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const matches: PortalFileLinkResolution[] = [];
    for (const root of roots) {
      if (link.absolute && !isPathInsideRoot(link.path, root.absolutePath)) {
        continue;
      }
      const candidatePath = link.absolute
        ? link.path
        : join(root.absolutePath, ...link.path.split('/'));
      try {
        const resolved = await resolveSharedContainerViewerFileForRead(
          request.worktreeId,
          candidatePath,
        );
        const info = await getSharedContainerReader().store.lstatEntryForRead(
          resolved.root.revisionRoot,
          resolved.target,
        );
        if (!info.isFile() || info.isSymbolicLink()) continue;
        matches.push({
          fileRootLocalId: resolved.root.repoId,
          relativePath: resolved.relativePath,
        });
      } catch {
        // Continue looking for one unambiguous declared replica path.
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  try {
    const { result } = await resolveFilesystemLink({
      roots: roots.map((root) => ({
        id: root.repoId,
        name: root.repoName,
        absolutePath: root.absolutePath,
      })),
      mode: 'transcript',
      href: request.href,
    });
    return {
      fileRootLocalId: result.fileRootId,
      relativePath: result.relativePath,
    };
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.code?.startsWith('worker.filesystem.link.') === true
    )
      return null;
    throw error;
  }
}

async function resolveRoot(
  workspaceLocalId: string,
  worktreeLocalId: string,
  fileRootLocalId?: string,
  repoId?: string,
): Promise<FileBrowserRoot> {
  validateId(workspaceLocalId, 'workspaceLocalId');
  validateId(worktreeLocalId, 'worktreeLocalId');
  validateOptionalRepoId(fileRootLocalId, 'fileRootLocalId');
  validateOptionalRepoId(repoId, 'repoId');
  const { roots, rootMap } = await getFileBrowserRoots(
    workspaceLocalId,
    worktreeLocalId,
  );
  const rootHint = fileRootLocalId ?? repoId;
  if (!rootHint && roots.length !== 1) {
    throw new PortalServiceError(
      'invalid_target',
      'File root is ambiguous; provide fileRootLocalId or repoId.',
    );
  }
  const root = rootHint ? rootMap.get(rootHint) : roots[0];
  if (!root) {
    throw new PortalServiceError(
      'not_found',
      `Unknown file root: ${rootHint ?? 'default'}`,
    );
  }
  return root;
}

function languageForPath(pathValue: string): string | undefined {
  const extension = extname(pathValue).slice(1).toLowerCase();
  return extension || undefined;
}

function versionFromStat(stats: Awaited<ReturnType<typeof stat>>): string {
  return `${Number(stats.size)}:${Math.round(Number(stats.mtimeMs))}`;
}

export async function resolvePortalFileTarget(
  request: PortalFileReadPayload,
): Promise<{
  root: FileBrowserRoot;
  rootReal: string;
  relativePath: string;
  joinedAbsolutePath: string;
}> {
  const root = await resolveRoot(
    request.projectId,
    request.worktreeId,
    request.fileRootLocalId,
    request.repoId,
  );
  const relativePath = normalizeRelativePath(request.relativePath);
  const rootReal = await realpath(root.absolutePath);
  const joinedAbsolutePath = relativePath
    ? join(root.absolutePath, ...relativePath.split('/'))
    : root.absolutePath;
  return { root, rootReal, relativePath, joinedAbsolutePath };
}

export async function resolvePortalChatAssetFileTarget(input: {
  projectId: string;
  worktreeId: string;
  path: string;
}): Promise<FileBrowserRoot | null> {
  validateId(input.projectId, 'projectId');
  validateId(input.worktreeId, 'worktreeId');
  const { roots } = await getFileBrowserRoots(
    input.projectId,
    input.worktreeId,
  );
  const candidates = roots.filter(
    (root) =>
      isPathInsideRoot(input.path, root.absolutePath) &&
      !root.excludedDescendantRoots.some((excluded) =>
        isPathInsideRoot(input.path, excluded),
      ),
  );
  candidates.sort(
    (left, right) => right.absolutePath.length - left.absolutePath.length,
  );
  return candidates[0] ?? null;
}

async function resolveExistingFileInsideRoot(
  targetPath: string,
  rootReal: string,
): Promise<string> {
  const targetReal = await realpath(targetPath);
  if (!isPathInsideRoot(targetReal, rootReal)) {
    throw new PortalServiceError(
      'invalid_target',
      'File is outside the selected worktree root.',
    );
  }
  return targetReal;
}

async function resolveCreatableFileInsideRoot(
  targetPath: string,
  rootReal: string,
): Promise<string> {
  let cursor = targetPath;
  for (;;) {
    try {
      const ancestorReal = await realpath(cursor);
      if (!isPathInsideRoot(ancestorReal, rootReal)) {
        throw new PortalServiceError(
          'invalid_target',
          'File is outside the selected worktree root.',
        );
      }
      return targetPath;
    } catch (error) {
      if (error instanceof PortalServiceError) {
        throw error;
      }
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      cursor = parent;
    }
  }
}

function rejectUnsupportedText(pathValue: string, content?: string): void {
  const extension = extname(pathValue).toLowerCase();
  const knownBinaryExtensions = new Set([
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.a',
    '.o',
    '.lib',
    '.obj',
    '.class',
    '.jar',
    '.war',
    '.pyc',
    '.pyo',
    '.wasm',
    '.zip',
    '.tar',
    '.gz',
    '.tgz',
    '.bz2',
    '.xz',
    '.7z',
    '.rar',
    '.iso',
    '.dmg',
    '.pkg',
    '.deb',
    '.rpm',
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.odt',
    '.ods',
    '.odp',
    '.rtf',
    '.ico',
    '.icns',
    '.ttf',
    '.otf',
    '.woff',
    '.woff2',
    '.eot',
    '.mp3',
    '.mp4',
    '.m4a',
    '.m4v',
    '.mov',
    '.avi',
    '.mkv',
    '.webm',
    '.wav',
    '.flac',
    '.ogg',
    '.opus',
    '.aac',
    '.wma',
    '.psd',
    '.ai',
    '.sketch',
    '.fig',
    '.blend',
    '.fbx',
    '.stl',
    '.db',
    '.sqlite',
    '.sqlite3',
    '.mdb',
    '.bin',
    '.dat',
    '.pack',
    '.idx',
  ]);
  if (knownBinaryExtensions.has(extension)) {
    throw new PortalServiceError(
      'invalid_target',
      'Binary files cannot be read or saved.',
    );
  }
  if (content?.includes('\0')) {
    throw new PortalServiceError(
      'invalid_payload',
      'File content cannot contain null bytes.',
    );
  }
}

export async function listFileRoots(
  request: FileTreeRootsRequest,
): Promise<PortalFileRoot[]> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const { roots } = await getFileBrowserRoots(
    request.projectId,
    request.worktreeId,
  );
  return roots.map((root) => ({
    workspaceLocalId: request.projectId,
    worktreeLocalId: request.worktreeId,
    fileRootLocalId: root.repoId,
    label: root.repoName,
    rootKind: root.rootKind,
    absolutePath: root.absolutePath,
  }));
}

function toPublicRoot(root: FileBrowserRoot): FileTreeRoot {
  return {
    repoId: root.repoId,
    repoName: root.repoName,
    absolutePath: root.absolutePath,
    rootKind: root.rootKind,
  };
}

export async function listFileTreeRoots(
  request: FileTreeRootsRequest,
): Promise<FileTreeRootsResponse> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const { roots } = await getFileBrowserRoots(
    request.projectId,
    request.worktreeId,
  );
  return { roots: roots.map(toPublicRoot) };
}

/**
 * Whole-worktree index entry caps. The mentions index stays in the renderer
 * for every worktree it was loaded for, so a repository with a large ignored
 * tree must not grow it without bound: one with 1.5 million ignored files
 * held 616 MiB there. Ignored directories are walked last, so a cap drops
 * those first.
 */
const FILE_INDEX_ENTRY_CAPS = {
  mentions: 100_000,
  'file-explorer': 25_000,
} as const;

/** A purpose's index entry cap, split evenly across a worktree's roots. */
export function fileIndexEntriesPerRoot(
  purpose: FileIndexRequest['purpose'],
  rootCount: number,
): number {
  const cap = FILE_INDEX_ENTRY_CAPS[purpose ?? 'mentions'];
  return Math.max(1, Math.floor(cap / Math.max(1, rootCount)));
}

interface FileIndexBuildSlot {
  running: Promise<FileIndexResponse>;
  next: Promise<FileIndexResponse> | null;
}

/**
 * Index walks in progress, by request. A worktree walk can take seconds and
 * Home, the explorer, and mentions often ask for the same index together. A
 * request made while a walk runs joins the one walk queued behind it, so a
 * burst costs at most two walks and every caller still gets a walk that
 * started after its request (a file created just before it is included).
 */
const fileIndexBuilds = new Map<string, FileIndexBuildSlot>();

function startFileIndexBuild(
  key: string,
  build: () => Promise<FileIndexResponse>,
): Promise<FileIndexResponse> {
  const slot: FileIndexBuildSlot = { running: build(), next: null };
  fileIndexBuilds.set(key, slot);
  const settle = (): void => {
    if (fileIndexBuilds.get(key) === slot) fileIndexBuilds.delete(key);
  };
  void slot.running.then(settle, settle);
  return slot.running;
}

function buildFileIndexFresh(
  key: string,
  build: () => Promise<FileIndexResponse>,
): Promise<FileIndexResponse> {
  const slot = fileIndexBuilds.get(key);
  if (!slot) return startFileIndexBuild(key, build);
  slot.next ??= slot.running.then(
    () => startFileIndexBuild(key, build),
    () => startFileIndexBuild(key, build),
  );
  return slot.next;
}

/**
 * Joins `build` to the index coalescer every index caller shares, so the
 * `file-index:get` projection over `worker.filesystem.search` and the retained
 * direct walks below still cost at most two walks per burst. A joined caller
 * gets whichever walk ran in its lane; every lane returns the same index.
 * A `lane` keeps a routed walk apart from the shared one.
 */
export function coalesceFileIndexBuild(
  request: FileIndexRequest,
  repoId: string | undefined,
  build: () => Promise<FileIndexResponse>,
  lane?: string,
): Promise<FileIndexResponse> {
  const key = [
    request.projectId,
    request.worktreeId,
    request.purpose ?? '',
    repoId ?? '',
    ...(lane !== undefined ? [lane] : []),
  ].join('\0');
  return buildFileIndexFresh(key, build);
}

/**
 * The retained direct index (Home, Portal mentions, Portal rebind); the
 * renderer's `file-index:get` is a projection over `worker.filesystem.search`.
 */
export async function buildFileIndexes(
  request: FileIndexRequest,
  options?: {
    /**
     * When set, index only the root whose repoId matches — used by the Home
     * surface to scope a multi-repo worktree index to the composer's
     * selected working directory. Unknown ids yield an empty index.
     */
    repoId?: string;
  },
): Promise<FileIndexResponse> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateOptionalRepoId(options?.repoId, 'repoId');
  return coalesceFileIndexBuild(request, options?.repoId, () =>
    walkFileIndexes(request, options),
  );
}

async function walkFileIndexes(
  request: FileIndexRequest,
  options?: { repoId?: string },
): Promise<FileIndexResponse> {
  const [{ roots: allRoots }, preferences] = await Promise.all([
    getFileBrowserRoots(request.projectId, request.worktreeId),
    readPreferencesFile(),
  ]);
  const roots = options?.repoId
    ? allRoots.filter((root) => root.repoId === options.repoId)
    : allRoots;
  const globMatcher =
    request.purpose === 'file-explorer'
      ? buildFileExplorerGlobMatcher()
      : buildFileGlobMatcher(preferences.fileIndexing);
  const maxEntriesPerRoot = fileIndexEntriesPerRoot(
    request.purpose,
    roots.length,
  );
  return {
    repos: await Promise.all(
      roots.map(async (root) => {
        const readBoundary = readBoundaryForRoot(root);
        const index = await buildFileIndexResult(
          root.absolutePath,
          {
            gitAware: root.gitAware,
            globMatcher,
            excludedDescendantRoots: root.excludedDescendantRoots,
            ...(readBoundary ? { readBoundary } : {}),
          },
          maxEntriesPerRoot,
        );
        return {
          repoId: root.repoId,
          repoName: root.repoName,
          absolutePath: root.absolutePath,
          rootKind: root.rootKind,
          files: index.files,
          truncated: index.truncated,
        };
      }),
    ),
  };
}

export async function listDirectory(
  request: FileTreeDirectoryRequest,
): Promise<PortalDirectoryListing> {
  const root = await resolveRoot(
    request.projectId,
    request.worktreeId,
    request.repoId,
  );
  const relativeDir = normalizeRelativePath(request.relativeDir);
  const preferences = await readPreferencesFile();
  const globMatcher = buildFileGlobMatcher(preferences.fileIndexing);
  const readBoundary = readBoundaryForRoot(root);
  const entries = await listFilesystemDirectory(
    root.absolutePath,
    relativeDir,
    {
      gitAware: root.gitAware,
      globMatcher,
      excludedDescendantRoots: root.excludedDescendantRoots,
      ...(readBoundary ? { readBoundary } : {}),
    },
  );
  return {
    workspaceLocalId: request.projectId,
    worktreeLocalId: request.worktreeId,
    fileRootLocalId: root.repoId,
    path: relativeDir,
    entries: entries
      .map((entry): PortalDirectoryListing['entries'][number] => ({
        name: entry.name,
        path: entry.relativePath,
        type: entry.kind === 'directory' ? 'directory' : 'file',
      }))
      .sort((left, right) =>
        left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type === 'directory'
            ? -1
            : 1,
      ),
  };
}

export async function listFileTreeDirectory(
  request: FileTreeDirectoryRequest,
): Promise<FileTreeDirectoryResponse> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateOptionalRepoId(request.repoId, 'repoId');
  const root = await resolveRoot(
    request.projectId,
    request.worktreeId,
    request.repoId,
  );
  const relativeDir = normalizeRelativePath(request.relativeDir);
  const preferences = await readPreferencesFile();
  const globMatcher = buildFileGlobMatcher(preferences.fileIndexing);
  const readBoundary = readBoundaryForRoot(root);
  return {
    entries: await listFilesystemDirectory(root, relativeDir, {
      gitAware: root.gitAware,
      globMatcher,
      ...(readBoundary ? { readBoundary } : {}),
    }),
  };
}

export async function readPortalFilePreview(
  request: PortalFileReadPayload,
): Promise<PortalFilePreview> {
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const root = await resolveRoot(
      request.projectId,
      request.worktreeId,
      request.fileRootLocalId,
      request.repoId,
    );
    const relativePath = normalizeRelativePath(request.relativePath);
    rejectUnsupportedText(relativePath);
    const opened = await readSharedContainerViewerFile(
      request.worktreeId,
      join(root.absolutePath, ...relativePath.split('/')),
    );
    const slice = opened.bytes.subarray(0, MAX_PREVIEW_BYTES);
    if (slice.includes(0)) {
      throw new PortalServiceError(
        'invalid_target',
        'Binary files cannot be read.',
      );
    }
    return {
      workspaceLocalId: request.projectId,
      worktreeLocalId: request.worktreeId,
      fileRootLocalId: root.repoId,
      path: relativePath,
      content: slice.toString('utf8'),
      language: languageForPath(relativePath),
      size: opened.sizeBytes,
      version: `${opened.sizeBytes}:${Math.round(opened.modifiedAtMs)}`,
      truncated: opened.sizeBytes > MAX_PREVIEW_BYTES,
      modifiedAt: new Date(opened.modifiedAtMs).toISOString(),
    };
  }
  const { root, rootReal, relativePath, joinedAbsolutePath } =
    await resolvePortalFileTarget(request);
  rejectUnsupportedText(relativePath);

  const targetReal = await resolveExistingFileInsideRoot(
    joinedAbsolutePath,
    rootReal,
  );
  const stats = await stat(targetReal);
  if (!stats.isFile()) {
    throw new PortalServiceError('invalid_target', 'Path is not a file.');
  }

  // Match the save path's O_NOFOLLOW: refuse to follow a final-component
  // symlink swapped in after the realpath containment check (TOCTOU). The
  // realpath check already rejects symlinks resolving outside the root;
  // O_NOFOLLOW closes the narrow race on the resolved final component.
  const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fh = await open(targetReal, readFlags);
  try {
    const maxBytes = Math.min(stats.size, MAX_PREVIEW_BYTES);
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buffer, 0, maxBytes, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      throw new PortalServiceError(
        'invalid_target',
        'Binary files cannot be read.',
      );
    }
    return {
      workspaceLocalId: request.projectId,
      worktreeLocalId: request.worktreeId,
      fileRootLocalId: root.repoId,
      path: relativePath,
      content: slice.toString('utf8'),
      language: languageForPath(relativePath),
      size: stats.size,
      version: versionFromStat(stats),
      truncated: stats.size > MAX_PREVIEW_BYTES,
      modifiedAt: stats.mtime.toISOString(),
    };
  } finally {
    await fh.close();
  }
}

export async function savePortalFile(
  request: PortalFileSavePayload,
): Promise<PortalFilePreview> {
  assertWritableScope(request.projectId);
  if (Buffer.byteLength(request.content, 'utf8') > MAX_SAVE_BYTES) {
    throw new PortalServiceError(
      'invalid_payload',
      'File content exceeds the 5 MB save limit.',
    );
  }

  const { root, rootReal, relativePath, joinedAbsolutePath } =
    await resolvePortalFileTarget(request);
  if (!relativePath) {
    throw new PortalServiceError('invalid_target', 'Path is not a file.');
  }
  rejectUnsupportedText(relativePath, request.content);

  let writePath: string;
  let existingStats: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    writePath = await resolveExistingFileInsideRoot(
      joinedAbsolutePath,
      rootReal,
    );
    existingStats = await stat(writePath);
    if (!existingStats.isFile()) {
      throw new PortalServiceError('invalid_target', 'Path is not a file.');
    }
  } catch (error) {
    if (error instanceof PortalServiceError) {
      throw error;
    }
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
    writePath = await resolveCreatableFileInsideRoot(
      joinedAbsolutePath,
      rootReal,
    );
  }

  if (
    existingStats &&
    typeof request.expectedModifiedAtMs === 'number' &&
    Math.abs(existingStats.mtimeMs - request.expectedModifiedAtMs) > 1
  ) {
    throw new PortalServiceError(
      'execution_failed',
      'The document changed after you started editing.',
    );
  }

  if (existingStats) {
    const flags =
      constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
    // The post-write realpath check below is the authoritative fail-closed
    // guard for parent-directory swaps between validation and open.
    const fh = await open(writePath, flags);
    try {
      await fh.writeFile(request.content, 'utf8');
    } finally {
      await fh.close();
    }
  } else {
    const flags =
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0);
    const fh = await open(writePath, flags, 0o666);
    try {
      await fh.writeFile(request.content, 'utf8');
    } finally {
      await fh.close();
    }
  }

  const savedPath = await realpath(writePath);
  if (!isPathInsideRoot(savedPath, rootReal)) {
    throw new PortalServiceError(
      'invalid_target',
      'Saved file escaped the selected worktree root.',
    );
  }
  const updated = await stat(savedPath);
  return {
    workspaceLocalId: request.projectId,
    worktreeLocalId: request.worktreeId,
    fileRootLocalId: root.repoId,
    path: relativePath,
    content: request.content,
    language: languageForPath(relativePath),
    size: updated.size,
    version: versionFromStat(updated),
    truncated: false,
    modifiedAt: updated.mtime.toISOString(),
  };
}

export async function readFilePreview(
  request: FileContentRequest,
): Promise<PortalFilePreview> {
  const stats = await stat(request.absolutePath);
  if (!stats.isFile()) {
    throw new PortalServiceError('invalid_target', 'Path is not a file.');
  }
  const fh = await open(request.absolutePath, 'r');
  try {
    const maxBytes = Math.min(stats.size, MAX_PREVIEW_BYTES);
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buffer, 0, maxBytes, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      throw new PortalServiceError(
        'invalid_target',
        'Binary files cannot be read.',
      );
    }
    return {
      workspaceLocalId: '',
      worktreeLocalId: '',
      path: request.absolutePath,
      content: slice.toString('utf8'),
      language: languageForPath(request.absolutePath),
      size: stats.size,
      version: versionFromStat(stats),
      truncated: stats.size > MAX_PREVIEW_BYTES,
      modifiedAt: stats.mtime.toISOString(),
    };
  } finally {
    await fh.close();
  }
}

export function toFileSnapshotPayload(
  listingOrPreview: PortalDirectoryListing | PortalFilePreview,
  rootScope?: { fileRootLocalId: string },
): PortalFileSnapshotPayload {
  // Transport plan Phase T1.2: snapshots MUST carry `fileRootLocalId`,
  // `workspaceLocalId`, `worktreeLocalId`, and a relative `filePath`.
  // The wire keys two repos with the same relative filename apart via
  // the composite cache key `${fileRootLocalId}:${filePath}`.
  const fileRootLocalId =
    rootScope?.fileRootLocalId ?? listingOrPreview.fileRootLocalId ?? '';
  if ('entries' in listingOrPreview) {
    return {
      fileRootLocalId,
      workspaceLocalId: listingOrPreview.workspaceLocalId,
      worktreeLocalId: listingOrPreview.worktreeLocalId,
      filePath: listingOrPreview.path,
      tree: listingOrPreview.entries.map(
        (entry: PortalDirectoryListing['entries'][number]) => ({
          name: entry.name,
          isDir: entry.type === 'directory',
        }),
      ),
    };
  }
  return {
    fileRootLocalId,
    workspaceLocalId: listingOrPreview.workspaceLocalId,
    worktreeLocalId: listingOrPreview.worktreeLocalId,
    filePath: listingOrPreview.path,
    contents: listingOrPreview.content,
    truncated: listingOrPreview.truncated,
    modifiedAtMs: listingOrPreview.modifiedAt
      ? new Date(listingOrPreview.modifiedAt).getTime()
      : undefined,
  };
}
