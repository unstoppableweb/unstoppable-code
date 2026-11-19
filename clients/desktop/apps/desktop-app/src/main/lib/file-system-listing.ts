import type {
  FileIndexEntry,
  FileTreeEntry,
} from '@canopy/desktop-shared/types';
import type { FileGlobMatcher } from './file-glob-matcher';
import {
  deferIgnoredDirectories,
  readFilesystemDirectory,
  readIgnoredPathMatcher,
  walkFileIndex,
  type FileSystemReadBoundary,
  type FilesystemRoot,
} from '@canopy/core-runtime/node';
export type { FileSystemReadBoundary } from '@canopy/core-runtime/node';
import { checkIgnoredPaths, listIgnoredPathEntries } from './git';

export interface FileSystemListingOptions {
  gitAware: boolean;
  globMatcher: FileGlobMatcher;
  excludedDescendantRoots?: string[];
  readBoundary?: FileSystemReadBoundary;
  /** Called when a failed ignore check made the listing use defaults. */
  onIgnoreStateUnknown?: () => void;
}

export interface FileIndexBuildResult {
  files: FileIndexEntry[];
  truncated: boolean;
}

export async function listDirectory(
  root:
    | string
    | Pick<
        FilesystemRoot,
        'absolutePath' | 'gitAware' | 'excludedDescendantRoots'
      >,
  relativeDir: string,
  options: FileSystemListingOptions,
): Promise<FileTreeEntry[]> {
  const catalogRoot =
    typeof root === 'string'
      ? {
          absolutePath: root,
          gitAware: options.gitAware,
          excludedDescendantRoots: options.excludedDescendantRoots ?? [],
        }
      : root;
  return readFilesystemDirectory(catalogRoot, relativeDir, {
    matchingRules: options.globMatcher,
    gitIgnore: { checkIgnoredPaths },
    ...(options.readBoundary ? { readBoundary: options.readBoundary } : {}),
    ...(options.onIgnoreStateUnknown
      ? { onIgnoreStateUnknown: options.onIgnoreStateUnknown }
      : {}),
  });
}

export async function buildFileIndex(
  root: string,
  options: FileSystemListingOptions,
): Promise<FileIndexEntry[]> {
  return (await buildFileIndexResult(root, options)).files;
}

/**
 * The retained direct index walk (Home, Portal mentions, rebind) over the
 * core-runtime engine `worker.filesystem.search` pages, with one ignored-path
 * listing per Git-aware root before the walk, which visits ignored
 * directories last.
 */
export async function buildFileIndexResult(
  root: string,
  options: FileSystemListingOptions,
  maxEntries = Number.POSITIVE_INFINITY,
): Promise<FileIndexBuildResult> {
  const isIgnored = await readIgnoredPathMatcher(
    options.gitAware
      ? (): Promise<string[]> => listIgnoredPathEntries(root)
      : null,
  );
  const walked = await walkFileIndex(
    {
      absolutePath: root,
      excludedDescendantRoots: options.excludedDescendantRoots ?? [],
    },
    {
      matcher: deferIgnoredDirectories(options.globMatcher, isIgnored),
      ...(options.readBoundary ? { readBoundary: options.readBoundary } : {}),
    },
    maxEntries,
  );
  return {
    files: walked.files.map((file) => ({
      relativePath: file.relativePath,
      filename: file.filename,
      absolutePath: file.absolutePath,
      isIgnored: isIgnored(file.relativePath),
    })),
    truncated: walked.truncated,
  };
}
