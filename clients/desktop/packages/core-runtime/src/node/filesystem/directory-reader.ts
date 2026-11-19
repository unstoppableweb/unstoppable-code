import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { FilesystemRoot } from './root-catalog';

export interface DirectoryMatchingRules {
  isIndexExcluded(relativePath: string, kind: 'file' | 'directory'): boolean;
}

export interface GitIgnoreReadPort {
  checkIgnoredPaths(
    root: string,
    relativePaths: string[],
  ): Promise<Set<string>>;
}

export interface DirectoryReadOptions {
  matchingRules: DirectoryMatchingRules;
  gitIgnore?: GitIgnoreReadPort;
  /** Called once when a failed ignore check made the listing use defaults. */
  onIgnoreStateUnknown?: () => void;
  readBoundary?: FileSystemReadBoundary;
}

/** Local read metadata; absolutePath is projected out by protocol adapters. */
export interface DirectoryReadEntry {
  name: string;
  relativePath: string;
  absolutePath: string;
  kind: 'file' | 'directory';
  isIgnored: boolean;
  isIndexExcluded: boolean;
  isSymlink: boolean;
  hasChildren: boolean;
}

const DEFAULT_IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
]);

/**
 * The conservative ignore list used while Git's ignore state is unknown:
 * dependency trees, `.env*` files, `.git` and common build outputs, at any
 * depth. A failed lookup must not present these as tracked sources.
 */
export function isDefaultIgnoredPath(relativePath: string): boolean {
  return relativePath
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .some(
      (segment) =>
        DEFAULT_IGNORED_SEGMENTS.has(segment) || segment.startsWith('.env'),
    );
}

export function hasGitPathSegment(pathValue: string): boolean {
  return pathValue
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .some((segment) => segment === '.git');
}

interface FileSystemEntryStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** Host-supplied no-follow reads for sealed or otherwise bounded trees. */
export interface FileSystemReadBoundary {
  assertDirectory(root: string, target: string): Promise<void>;
  readDirectory(root: string, target: string): Promise<Dirent[]>;
  lstatEntry(root: string, target: string): Promise<FileSystemEntryStats>;
}

interface DirectoryEntryData {
  entry: Dirent;
  absolutePath: string;
  relativePath: string;
  kind: 'file' | 'directory';
  isSymlink: boolean;
}

function toRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

function isMissingError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return Reflect.get(error, 'code') === 'ENOENT';
}

function isPathInsideRoot(absolutePath: string, root: string): boolean {
  const resolvedPath = resolve(absolutePath);
  const resolvedRoot = resolve(root);
  return (
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${sep}`)
  );
}

async function ensureDirectoryResolvesInsideRoot(
  root: string,
  directoryAbsolutePath: string,
  readBoundary?: FileSystemReadBoundary,
): Promise<boolean> {
  if (readBoundary) {
    try {
      await readBoundary.assertDirectory(root, directoryAbsolutePath);
      return true;
    } catch (error) {
      if (isMissingError(error)) return false;
      throw error instanceof Error
        ? error
        : new Error('Unable to resolve path');
    }
  }
  let resolvedRoot: string;
  let resolvedDirectory: string;
  try {
    resolvedRoot = await realpath(root);
    resolvedDirectory = await realpath(directoryAbsolutePath);
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw error instanceof Error ? error : new Error('Unable to resolve path');
  }

  if (!isPathInsideRoot(resolvedDirectory, resolvedRoot)) {
    throw new Error('Cannot list a directory outside the file tree root');
  }
  return true;
}

function shouldSkipAbsolutePath(
  absolutePath: string,
  excludedDescendantRoots: readonly string[],
): boolean {
  return excludedDescendantRoots.some(
    (excludedRoot) => resolve(absolutePath) === resolve(excludedRoot),
  );
}

async function classifyDirent(
  root: string,
  parentAbsolutePath: string,
  entry: Dirent,
  excludedDescendantRoots: readonly string[],
  readBoundary?: FileSystemReadBoundary,
): Promise<DirectoryEntryData | null> {
  if (entry.name === '.git') {
    return null;
  }

  const absolutePath = join(parentAbsolutePath, entry.name);
  if (shouldSkipAbsolutePath(absolutePath, excludedDescendantRoots)) {
    return null;
  }
  const relativePath = toRelativePath(root, absolutePath);
  if (hasGitPathSegment(relativePath)) {
    return null;
  }

  let entryStat = readBoundary
    ? await readBoundary.lstatEntry(root, absolutePath)
    : await lstat(absolutePath);
  const isSymlink = entryStat.isSymbolicLink();
  if (isSymlink) {
    // Sealed replicas never follow links, including links inside the root.
    if (readBoundary) return null;
    try {
      const resolvedRoot = await realpath(root);
      const resolvedTarget = await realpath(absolutePath);
      if (
        hasGitPathSegment(resolvedTarget) ||
        !isPathInsideRoot(resolvedTarget, resolvedRoot)
      ) {
        return null;
      }
      entryStat = await stat(absolutePath);
    } catch {
      return null;
    }
  }

  if (entryStat.isDirectory()) {
    return {
      entry,
      absolutePath,
      relativePath,
      kind: 'directory',
      isSymlink,
    };
  }

  if (entryStat.isFile()) {
    return {
      entry,
      absolutePath,
      relativePath,
      kind: 'file',
      isSymlink,
    };
  }

  return null;
}

export async function readDirectoryEntries(
  root: string,
  directoryAbsolutePath: string,
  excludedDescendantRoots: readonly string[],
  readBoundary?: FileSystemReadBoundary,
): Promise<DirectoryEntryData[]> {
  let entries: Dirent[];
  try {
    entries = readBoundary
      ? await readBoundary.readDirectory(root, directoryAbsolutePath)
      : await readdir(directoryAbsolutePath, { withFileTypes: true });
  } catch (error) {
    if (isMissingError(error)) {
      return [];
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  const classified = await Promise.all(
    entries.map((entry) =>
      classifyDirent(
        root,
        directoryAbsolutePath,
        entry,
        excludedDescendantRoots,
        readBoundary,
      ),
    ),
  );
  return classified.filter((entry): entry is DirectoryEntryData =>
    Boolean(entry),
  );
}

export function sortDirectoryEntries<
  T extends { kind: 'file' | 'directory'; name: string },
>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

async function getIgnoredPaths(
  root: string,
  gitAware: boolean,
  relativePaths: string[],
  gitIgnore?: GitIgnoreReadPort,
  onIgnoreStateUnknown?: () => void,
): Promise<Set<string>> {
  if (!gitAware || !gitIgnore || relativePaths.length === 0) {
    return new Set();
  }
  try {
    return await gitIgnore.checkIgnoredPaths(root, relativePaths);
  } catch {
    onIgnoreStateUnknown?.();
    return new Set(relativePaths.filter(isDefaultIgnoredPath));
  }
}

export async function readFilesystemDirectory(
  catalogRoot: Pick<
    FilesystemRoot,
    'absolutePath' | 'gitAware' | 'excludedDescendantRoots'
  >,
  relativeDir: string,
  options: DirectoryReadOptions,
): Promise<DirectoryReadEntry[]> {
  const root = catalogRoot.absolutePath;
  const excludedDescendantRoots = catalogRoot.excludedDescendantRoots;
  const directoryAbsolutePath = relativeDir
    ? join(root, ...relativeDir.split('/').filter(Boolean))
    : root;
  if (!isPathInsideRoot(directoryAbsolutePath, root)) {
    throw new Error('Cannot list a directory outside the file tree root');
  }
  const directoryExistsInsideRoot = await ensureDirectoryResolvesInsideRoot(
    root,
    directoryAbsolutePath,
    options.readBoundary,
  );
  if (!directoryExistsInsideRoot) {
    return [];
  }

  const entries = await readDirectoryEntries(
    root,
    directoryAbsolutePath,
    excludedDescendantRoots,
    options.readBoundary,
  );
  const relativePaths = entries.map((entry) => entry.relativePath);
  const ignoredPaths = await getIgnoredPaths(
    root,
    catalogRoot.gitAware,
    relativePaths,
    options.gitIgnore,
    options.onIgnoreStateUnknown,
  );
  const treeEntries = entries.map(
    (entry): DirectoryReadEntry => ({
      name: entry.entry.name,
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
      kind: entry.kind,
      isIgnored: ignoredPaths.has(entry.relativePath),
      isIndexExcluded: options.matchingRules.isIndexExcluded(
        entry.relativePath,
        entry.kind,
      ),
      isSymlink: entry.isSymlink,
      hasChildren: entry.kind === 'directory' && !entry.isSymlink,
    }),
  );
  return sortDirectoryEntries(treeEntries);
}
