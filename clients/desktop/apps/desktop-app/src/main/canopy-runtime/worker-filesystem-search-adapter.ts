import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import {
  filesystemSearchError,
  type FileSystemReadBoundary,
  type FilesystemSearchEngine,
  type FilesystemSearchPage,
} from '@canopy/core-runtime/node';
import {
  createFileIndexingMatchPolicy,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';
import type {
  CanopyQueryHandlerMap,
  WorkerFilesystemSearchResult,
} from '@canopy/protocol/canopy-core';
import type { FileIndexingPreferences } from '@canopy/protocol/file-indexing';
import {
  getFileBrowserRoots,
  type FileBrowserRoot,
  type FileBrowserRootsResult,
} from '../lib/file-browser-roots';
import {
  buildFileExplorerGlobMatcher,
  buildFileGlobMatcher,
} from '../lib/file-glob-matcher';
import { listIgnoredPathEntries } from '../lib/git';
import { readPreferencesFile } from '../lib/preferences-store';
import { validateId } from '../lib/validation';
import { readBoundaryForRoot } from '../services/files-service';
import { RENDERER_RELAY_LIMITS } from './renderer-relay/relay';
import {
  requireDesktopScope,
  translateFilesServiceError,
} from './worker-filesystem-adapter';

export interface WorkerFilesystemSearchServices {
  getFileBrowserRoots(
    projectId: string,
    worktreeId: string,
  ): Promise<FileBrowserRootsResult>;
  readFileIndexingPreferences(): Promise<FileIndexingPreferences>;
  /** Desktop Git's `ls-files --others --ignored` listing, as today's index. */
  listIgnoredPathEntries(root: string): Promise<string[]>;
  readBoundaryForRoot(
    root: FileBrowserRoot,
  ): FileSystemReadBoundary | undefined;
}

export const DEFAULT_FILE_SEARCH_SERVICES: WorkerFilesystemSearchServices = {
  getFileBrowserRoots,
  readFileIndexingPreferences: async () =>
    (await readPreferencesFile()).fileIndexing,
  listIgnoredPathEntries,
  readBoundaryForRoot,
};

/** Per-request hooks the legacy `file-index:get` projection installs. */
export interface WorkerFilesystemSearchProjection {
  /** The root and preferences the projection already read, if any. */
  root(
    projectId: string,
    worktreeId: string,
    fileRootId: string,
  ): { root: FileBrowserRoot; fileIndexing: FileIndexingPreferences } | null;
  /** The engine's page, with each match's local path. */
  capture(page: FilesystemSearchPage): void;
}

export interface WorkerFilesystemSearchAdapterOptions {
  engine: FilesystemSearchEngine;
  services?: WorkerFilesystemSearchServices;
  projection?: WorkerFilesystemSearchProjection;
}

type WorkerFilesystemSearchHandlerMap = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  'worker.filesystem.search'
>;

/**
 * Keeps typed `worker.filesystem.search.*` failures; anything else (a roots
 * read, an ID check, a walk error) is translated as the Files adapter
 * translates it, with the original error as its runtime cause, so the legacy
 * projection can rethrow it unchanged.
 */
function toSearchError(error: unknown): unknown {
  if (
    error instanceof CanopyOperationError &&
    (error.payload.code === undefined ||
      error.payload.code.startsWith('worker.filesystem.search.'))
  )
    return error;
  const translated = translateFilesServiceError(error);
  return new CanopyOperationError(
    translated.payload,
    translated.runtimeCause ?? error,
  );
}

/**
 * `worker.filesystem.search` on the desktop dispatcher. A new walk resolves
 * its root from the desktop file-browser roots (or from the legacy
 * projection that already read them); the walk is the core-runtime engine,
 * and Git-aware roots are marked with desktop Git's ignored listing.
 *
 * Any caller may be the renderer relay, which refuses a reply over its cap,
 * so pages are byte-bounded and continue by cursor. The `file-index:get`
 * projection runs in process and pages unbounded, as its walk always did.
 */
export function createWorkerFilesystemSearchAdapter(
  options: WorkerFilesystemSearchAdapterOptions,
): WorkerFilesystemSearchHandlerMap {
  const services = options.services ?? DEFAULT_FILE_SEARCH_SERVICES;
  const policy = createFileIndexingMatchPolicy(hostPlatformOperatingSystem());
  return {
    'worker.filesystem.search': async (
      params,
      context,
    ): Promise<WorkerFilesystemSearchResult> => {
      try {
        const { projectId, worktreeId } = requireDesktopScope(params.scope);
        validateId(projectId, 'projectId');
        validateId(worktreeId, 'worktreeId');
        const projected = options.projection?.root(
          projectId,
          worktreeId,
          params.fileRootId,
        );
        const page = await options.engine.search(params, {
          resolve: async () => {
            const root =
              projected?.root ??
              (
                await services.getFileBrowserRoots(projectId, worktreeId)
              ).roots.find((entry) => entry.repoId === params.fileRootId);
            if (!root) throw filesystemSearchError('notFound');
            const fileIndexing =
              projected?.fileIndexing ??
              (await services.readFileIndexingPreferences());
            const readBoundary = services.readBoundaryForRoot(root);
            return {
              root: {
                id: root.repoId,
                absolutePath: root.absolutePath,
                gitAware: root.gitAware,
                excludedDescendantRoots: root.excludedDescendantRoots,
              },
              inputs: {
                matcher:
                  params.purpose === 'file-explorer'
                    ? buildFileExplorerGlobMatcher()
                    : buildFileGlobMatcher(fileIndexing),
                policy,
                ...(readBoundary && { readBoundary }),
                listIgnoredPathEntries: (path): Promise<string[]> =>
                  services.listIgnoredPathEntries(path),
              },
            };
          },
          ...(!projected && {
            maxResultBytes: RENDERER_RELAY_LIMITS.maxReplyBytes,
          }),
          signal: context.signal,
        });
        options.projection?.capture(page);
        return page.result;
      } catch (error) {
        throw toSearchError(error);
      }
    },
  };
}
