import type {
  FileContentRequest,
  FileContentResponse,
  FileIndexRequest,
  FileIndexResponse,
  FileTreeDirectoryRequest,
  FileTreeDirectoryResponse,
  FileTreeRootsRequest,
  FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import type { ScopedFileQueries } from '@canopy/ipc-canopy-client';
import { isWebCoreScope } from '../chat-authority';
import { createWebCoreFileQueries } from './web-core-file-queries';
import { createWebCoreFileSource } from './web-core-file-source';

/** The file reads the explorer and viewer make for one work entry (CAN-6175 D2). */
export interface WorkspaceFileSource {
  getFileIndex(request: FileIndexRequest): Promise<FileIndexResponse>;
  getFileTreeRoots(
    request: FileTreeRootsRequest,
  ): Promise<FileTreeRootsResponse>;
  getFileTreeDirectory(
    request: FileTreeDirectoryRequest,
  ): Promise<FileTreeDirectoryResponse>;
  readFileContent(request: FileContentRequest): Promise<FileContentResponse>;
}

/** The local IPC reads, unchanged; `window.api` is read at call time. */
export const localWorkspaceFileSource: WorkspaceFileSource = {
  getFileIndex: (request) => window.api.getFileIndex(request),
  getFileTreeRoots: (request) => window.api.getFileTreeRoots(request),
  getFileTreeDirectory: (request) => window.api.getFileTreeDirectory(request),
  readFileContent: (request) => window.api.readFileContent(request),
};

let webCoreFileSource: WorkspaceFileSource | null = null;

/** A cloud chat's work entry reads through the web core; any other, locally. */
export function workspaceFileSourceFor(
  worktreeId: string,
): WorkspaceFileSource {
  if (!isWebCoreScope(worktreeId)) return localWorkspaceFileSource;
  webCoreFileSource ??= createWebCoreFileSource(window.canopyCore);
  return webCoreFileSource;
}

let webCoreFileQueries: ScopedFileQueries | null = null;

/** The shared viewer's file queries for a cloud chat; undefined keeps IPC. */
export function scopedFileQueriesFor(
  worktreeId: string,
): ScopedFileQueries | undefined {
  if (!isWebCoreScope(worktreeId)) return undefined;
  webCoreFileQueries ??= createWebCoreFileQueries(window.canopyCore);
  return webCoreFileQueries;
}
