import type {
  FileIndexEntry,
  FileTreeRoot,
} from '@canopy/desktop-shared/types';
import {
  isCoworkWorkspaceFileRoot,
  partitionFileRoots,
  type FileRootGroups,
} from '@canopy/ui-shared/lib/file-root-groups';
import {
  isFileIndexStale,
  isFileTreeCacheStale,
  type CachedDirectoryEntry,
  type CachedIndexEntry,
  type CachedRootsEntry,
  type FileTreeLoadError,
} from '@/stores/fileListStore';

/**
 * Stable expand/collapse identifier for a tree root. Using `repoId` keeps
 * paths unique even when two roots share a `repoName` (e.g. workspace
 * attachments + a child repo named "attachments").
 */
export function getRepoTreePath(root: Pick<FileTreeRoot, 'repoId'>): string {
  return `repo:${root.repoId}`;
}

/**
 * Expand/collapse identifier for the brand-labelled group of app-owned roots.
 * Directory and root identifiers always start with `repo:`, so this key can
 * never collide with a filesystem node, and it does not change with the brand.
 */
export const APP_MANAGED_ROOTS_TREE_PATH = 'group:app-managed';

/**
 * Roving-focus id of the group row. Explorer node ids always contain a `:`
 * between the encoded root id and path, so this id cannot match one.
 */
export const APP_MANAGED_ROOTS_NODE_ID = 'group-app-managed';

/** Splits roots into the user's roots and the app-owned group by catalog identity. */
export function partitionFileTreeRoots(
  roots: readonly FileTreeRoot[],
): FileRootGroups<FileTreeRoot> {
  return partitionFileRoots(roots, (root) => ({
    id: root.repoId,
    kind: root.rootKind,
  }));
}

/** Whether a root is the Cowork project's own working folder. */
export function isCoworkWorkspaceFileTreeRoot(
  root: Pick<FileTreeRoot, 'repoId' | 'rootKind'>,
): boolean {
  return isCoworkWorkspaceFileRoot({ id: root.repoId, kind: root.rootKind });
}

/**
 * Whether an expanded tree path is actually rendered: its root and every
 * ancestor directory are expanded, and a root inside the app-owned group also
 * needs the group expanded. Hidden descendants must not trigger refreshes.
 */
export function isVisibleExpandedTreePath(
  treePath: string,
  expandedPaths: ReadonlySet<string>,
  groupedRootTreePaths: ReadonlySet<string> = new Set(),
): boolean {
  const separatorIndex = treePath.indexOf('/');
  const rootTreePath =
    separatorIndex === -1 ? treePath : treePath.slice(0, separatorIndex);
  if (!rootTreePath.startsWith('repo:') || !expandedPaths.has(rootTreePath)) {
    return false;
  }
  if (
    groupedRootTreePaths.has(rootTreePath) &&
    !expandedPaths.has(APP_MANAGED_ROOTS_TREE_PATH)
  ) {
    return false;
  }
  if (separatorIndex === -1) return true;
  const repoId = rootTreePath.slice('repo:'.length);
  const segments = treePath.slice(separatorIndex + 1).split('/');
  return segments.every((_segment, index) =>
    expandedPaths.has(
      getDirectoryTreePath(repoId, segments.slice(0, index + 1).join('/')),
    ),
  );
}

/**
 * Compose the expand/collapse identifier for a directory under a root.
 * Empty `relativePath` returns the root's own identifier.
 */
export function getDirectoryTreePath(
  repoId: string,
  relativePath: string,
): string {
  if (relativePath.length === 0) {
    return getRepoTreePath({ repoId });
  }
  return `repo:${repoId}/${relativePath}`;
}

/**
 * Whether the root descriptors should be (re)fetched. Mirrors the staleness
 * pattern used by the legacy file-list cache.
 */
export function shouldFetchFilesTreeRoots(
  projectId: string | null,
  worktreeId: string | null,
  entry: CachedRootsEntry | undefined,
  isLoading: boolean,
  error: string | undefined,
): boolean {
  return (
    projectId !== null &&
    worktreeId !== null &&
    !isLoading &&
    error === undefined &&
    isFileTreeCacheStale(entry)
  );
}

/**
 * Whether a directory's cached children should be (re)fetched. Used to
 * trigger lazy loads when the user expands a directory the first time.
 */
export function shouldFetchFilesTreeDirectory(
  projectId: string | null,
  worktreeId: string | null,
  entry: CachedDirectoryEntry | undefined,
  isLoading: boolean,
  error: FileTreeLoadError | undefined,
): boolean {
  // An error waits for Try again, a refresh, or (for a sleeping cloud
  // sandbox) a turn, which clears it.
  if (projectId === null || worktreeId === null) return false;
  if (isLoading || error !== undefined) return false;
  return isFileTreeCacheStale(entry);
}

/**
 * Whether the flat file index backing explorer search should be (re)fetched.
 * The lazy tree only knows the directories the user already expanded, so the
 * search filter reads the same worktree-wide index Cmd+P and `@` mentions use.
 * Only called while a search query is active, so the walk stays off the
 * explorer's normal open/expand path.
 */
export function shouldFetchFilesTreeIndex(
  projectId: string | null,
  worktreeId: string | null,
  entry: CachedIndexEntry | undefined,
  isLoading: boolean,
  error: string | undefined,
): boolean {
  return (
    projectId !== null &&
    worktreeId !== null &&
    !isLoading &&
    error === undefined &&
    isFileIndexStale(entry)
  );
}

/**
 * Debounce applied between the last keystroke in the explorer search input and
 * the filter actually running, so typing does not rebuild the tree per key.
 */
export const FILE_TREE_SEARCH_DEBOUNCE_MS = 180;

/**
 * Upper bound on files rendered for one search. A one-character query can match
 * tens of thousands of paths in a large monorepo; the tree is not virtualized,
 * so the cap is what keeps a broad query from freezing the renderer. The UI
 * reports the total match count alongside the truncated list rather than
 * silently dropping the remainder.
 */
export const FILE_TREE_SEARCH_RESULT_LIMIT = 500;

/** A matched file in a search-filtered tree. */
export interface FilteredFileTreeFile {
  kind: 'file';
  name: string;
  relativePath: string;
  absolutePath: string;
  isIgnored: boolean;
}

/**
 * An ancestor directory retained purely because something under it matched.
 * Directories are never matched on their own; they exist in the result so a
 * hit keeps the folder parentage it has in the unfiltered tree.
 */
export interface FilteredFileTreeDirectory {
  kind: 'directory';
  name: string;
  relativePath: string;
  absolutePath: string;
  children: FilteredFileTreeNode[];
}

export type FilteredFileTreeNode =
  | FilteredFileTreeDirectory
  | FilteredFileTreeFile;

export interface FilteredFileTree {
  /** Top-level nodes directly under the root. */
  nodes: FilteredFileTreeNode[];
  /** Files actually present in {@link nodes} after the result cap. */
  shownCount: number;
  /** Files matching the query before the result cap. */
  matchCount: number;
}

interface MutableFilteredDirectory {
  name: string;
  relativePath: string;
  absolutePath: string;
  directories: Map<string, MutableFilteredDirectory>;
  files: FilteredFileTreeFile[];
}

const EMPTY_FILTERED_TREE: FilteredFileTree = {
  nodes: [],
  shownCount: 0,
  matchCount: 0,
};

/**
 * Normalize a raw search input into the value the filter compares against.
 * Empty result means "no active filter".
 */
export function normalizeFileTreeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Whether a file's repo-relative path matches the query. Case-insensitive
 * substring over the whole relative path, so both `button` and `src/ui/but`
 * work and the behavior stays predictable for a filter (as opposed to the
 * fuzzy scoring Cmd+P uses to *rank* a flat list).
 */
export function matchesFileTreeSearchQuery(
  relativePath: string,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) return false;
  return relativePath.toLowerCase().includes(normalizedQuery);
}

/**
 * Recover the absolute path of an ancestor directory from one of its matched
 * files. `absolutePath` is the root prefix plus `relativePath` with the host
 * separator substituted 1:1, so the two strings differ by a constant prefix
 * length and slicing at the ancestor's relative length is exact on both POSIX
 * and Windows. Returns an empty string when the invariant does not hold, which
 * only costs the folder row its reveal/copy actions.
 */
function resolveAncestorAbsolutePath(
  file: FileIndexEntry,
  ancestorRelativePath: string,
): string {
  const rootPrefixLength = file.absolutePath.length - file.relativePath.length;
  if (rootPrefixLength < 0) return '';
  return file.absolutePath.slice(
    0,
    rootPrefixLength + ancestorRelativePath.length,
  );
}

function createMutableDirectory(
  name: string,
  relativePath: string,
  absolutePath: string,
): MutableFilteredDirectory {
  return {
    name,
    relativePath,
    absolutePath,
    directories: new Map<string, MutableFilteredDirectory>(),
    files: [],
  };
}

function toFilteredNodes(
  directory: MutableFilteredDirectory,
): FilteredFileTreeNode[] {
  const directories = Array.from(directory.directories.values())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      (child): FilteredFileTreeDirectory => ({
        kind: 'directory',
        name: child.name,
        relativePath: child.relativePath,
        absolutePath: child.absolutePath,
        children: toFilteredNodes(child),
      }),
    );
  const files = [...directory.files].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return [...directories, ...files];
}

/**
 * Build the search-filtered subtree for one root: every file whose relative
 * path matches, re-nested under the directories that contain it. Directories
 * with no surviving descendant are dropped, so what is left is exactly the
 * matches plus their parentage.
 *
 * `limit` caps the files placed in the tree; `matchCount` still reports every
 * match so the caller can tell the user the list is truncated.
 */
export function buildFilteredFileTree(
  files: readonly FileIndexEntry[],
  query: string,
  limit: number = FILE_TREE_SEARCH_RESULT_LIMIT,
): FilteredFileTree {
  const normalizedQuery = normalizeFileTreeSearchQuery(query);
  if (normalizedQuery.length === 0 || limit <= 0) {
    // Still report the match count so a caller that ran out of budget on an
    // earlier root can show an accurate "N matches" total.
    if (normalizedQuery.length === 0) return EMPTY_FILTERED_TREE;
    return {
      nodes: [],
      shownCount: 0,
      matchCount: files.filter((file) =>
        matchesFileTreeSearchQuery(file.relativePath, normalizedQuery),
      ).length,
    };
  }

  const matched: FileIndexEntry[] = [];
  let matchCount = 0;
  for (const file of files) {
    if (!matchesFileTreeSearchQuery(file.relativePath, normalizedQuery)) {
      continue;
    }
    matchCount += 1;
    if (matched.length < limit) {
      matched.push(file);
    }
  }
  if (matched.length === 0) {
    return { nodes: [], shownCount: 0, matchCount };
  }

  matched.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );

  const rootDirectory = createMutableDirectory('', '', '');
  for (const file of matched) {
    const segments = file.relativePath.split('/');
    const fileName = segments.pop() ?? file.relativePath;
    let parent = rootDirectory;
    let parentRelativePath = '';
    for (const segment of segments) {
      parentRelativePath =
        parentRelativePath.length === 0
          ? segment
          : `${parentRelativePath}/${segment}`;
      let child = parent.directories.get(segment);
      if (!child) {
        child = createMutableDirectory(
          segment,
          parentRelativePath,
          resolveAncestorAbsolutePath(file, parentRelativePath),
        );
        parent.directories.set(segment, child);
      }
      parent = child;
    }
    parent.files.push({
      kind: 'file',
      name: fileName,
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      isIgnored: file.isIgnored,
    });
  }

  return {
    nodes: toFilteredNodes(rootDirectory),
    shownCount: matched.length,
    matchCount,
  };
}

/**
 * Compute the auto-expand path the very first time roots load. A Cowork
 * catalog expands the user's working folder and leaves the app-owned group
 * collapsed; any other catalog expands its root only when it has exactly one.
 * The caller passes `didAutoExpand` so the tab only auto-expands once per
 * mount.
 */
export function getAutoExpandRepoPath(
  roots: FileTreeRoot[],
  didAutoExpand: boolean,
): string | null {
  if (didAutoExpand) return null;
  const coworkRoots = roots.filter(isCoworkWorkspaceFileTreeRoot);
  const [coworkRoot] = coworkRoots;
  if (coworkRoots.length === 1 && coworkRoot) {
    return getRepoTreePath(coworkRoot);
  }
  if (roots.length !== 1) {
    return null;
  }
  const [onlyRoot] = roots;
  return getRepoTreePath(onlyRoot);
}
