import type {
  FileContentRequest,
  FileContentResponse,
  FileIndexRequest,
  FileIndexResponse,
  FileTreeDirectoryRequest,
  FileTreeDirectoryResponse,
  FileTreeMutationRequest,
  FileTreeMutationResponse,
  FileTreeRootsRequest,
  FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import type { ScopedFileOperations } from '@canopy/ipc-canopy-client';
import { isWebCoreScope } from '../chat-authority';
import { createWebCoreFileOperations } from './web-core-file-operations';
import { createWebCoreFileSource } from './web-core-file-source';

/** The file reads and writes the explorer and viewer make for one work entry (CAN-6175 D2). */
export interface WorkspaceFileSource {
  /**
   * The files are on this computer: the OS can open, reveal, watch and trash
   * them, and main copies them. A cloud chat's sandbox files are none of
   * these, so the explorer hides those actions.
   */
  readonly onThisComputer: boolean;
  getFileIndex(request: FileIndexRequest): Promise<FileIndexResponse>;
  getFileTreeRoots(
    request: FileTreeRootsRequest,
  ): Promise<FileTreeRootsResponse>;
  getFileTreeDirectory(
    request: FileTreeDirectoryRequest,
  ): Promise<FileTreeDirectoryResponse>;
  mutateFileTree(
    request: FileTreeMutationRequest,
  ): Promise<FileTreeMutationResponse>;
  readFileContent(request: FileContentRequest): Promise<FileContentResponse>;
}

/** The local IPC reads, unchanged; `window.api` is read at call time. */
export const localWorkspaceFileSource: WorkspaceFileSource = {
  onThisComputer: true,
  getFileIndex: (request) => window.api.getFileIndex(request),
  getFileTreeRoots: (request) => window.api.getFileTreeRoots(request),
  getFileTreeDirectory: (request) => window.api.getFileTreeDirectory(request),
  mutateFileTree: (request) => window.api.mutateFileTree(request),
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

let webCoreFileOperations: ScopedFileOperations | null = null;

/** The shared viewer's file operations for a cloud chat; undefined keeps IPC. */
export function scopedFileOperationsFor(
  worktreeId: string,
): ScopedFileOperations | undefined {
  if (!isWebCoreScope(worktreeId)) return undefined;
  webCoreFileOperations ??= createWebCoreFileOperations(window.canopyCore);
  return webCoreFileOperations;
}
