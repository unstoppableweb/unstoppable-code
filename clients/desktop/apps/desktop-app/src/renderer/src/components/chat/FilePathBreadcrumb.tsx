/**
 * FilePathBreadcrumb — the interactive path shown in a file panel's header.
 *
 * Replaces the raw path text with clickable segments: the root (repo) name,
 * each parent folder, and the file name (rendered less muted than its
 * parents). Clicking a segment opens a dropdown listing that segment's
 * parent directory, with the segment's own folder pre-expanded — a compact
 * inline tree for hopping to sibling files. Folder rows expand in place;
 * file rows open through `chatStore.openFileTab`, which activates an
 * existing tab for the file or opens a new file tab.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { FileTreeEntry, FileTreeRoot } from '@canopy/desktop-shared/types';
import {
  ChevronDownIcon,
  ChevronRightIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { FolderIcon } from '@canopy/ui-shared/icons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { isCoworkWorkspaceFileTreeRoot } from '@/components/activity/files-tree-tab-state';
import { FileTypeIcon } from '@canopy/ui-shared/icons';
import { Button, FloatingMenu } from '@canopy/ui-shared/components';
import { LoadingSpinner } from '@/components/shared/loading';
import { useChatStore } from '@/stores/chatStore';
import {
  getDirectoryCacheKey,
  getWorktreeCacheKey,
  isFileTreeCacheStale,
  useFileListStore,
} from '@/stores/fileListStore';

export interface FilePathBreadcrumbProps {
  projectId: string;
  worktreeId: string;
  /** The resolved file-tree root the open file lives under. */
  root: FileTreeRoot;
  /** Path of the open file relative to `root`, '/'-separated. */
  relativePath: string;
  /**
   * Override for what selecting a file in a segment menu does. Defaults to
   * `chatStore.openFileTab` (activate existing tab or open a new one).
   */
  onOpenFile?: (file: { absolutePath: string; filename: string }) => void;
}

interface SegmentMenuState {
  /** Index into the rendered segment list, for anchor identity. */
  segmentIndex: number;
  anchorEl: HTMLElement;
  /** Directory (relative to root) the menu lists; '' = the root itself. */
  baseDir: string;
  /** Folder (relative to root) to pre-expand inside the menu, if any. */
  expandTarget: string | null;
}

function BreadcrumbDirectory({
  projectId,
  worktreeId,
  repoId,
  relativeDir,
  depth,
  expandedDirs,
  onToggleDir,
  highlightPath,
  onPickFile,
}: {
  projectId: string;
  worktreeId: string;
  repoId: string;
  relativeDir: string;
  depth: number;
  expandedDirs: ReadonlySet<string>;
  onToggleDir: (relativePath: string) => void;
  highlightPath: string | null;
  onPickFile: (entry: FileTreeEntry) => void;
}): JSX.Element {
  const cacheKey = getDirectoryCacheKey(
    projectId,
    worktreeId,
    repoId,
    relativeDir,
  );
  const entry = useFileListStore((s) => s.directoryCache[cacheKey]);
  const error = useFileListStore((s) => s.directoryErrors[cacheKey]);
  const loading = useFileListStore((s) => s.directoryLoading.has(cacheKey));
  const fetchFileTreeDirectory = useFileListStore(
    (s) => s.fetchFileTreeDirectory,
  );

  useEffect(() => {
    if (
      (entry === undefined || isFileTreeCacheStale(entry)) &&
      !loading &&
      error === undefined
    ) {
      void fetchFileTreeDirectory(projectId, worktreeId, repoId, relativeDir);
    }
  }, [
    entry,
    error,
    fetchFileTreeDirectory,
    loading,
    projectId,
    relativeDir,
    repoId,
    worktreeId,
  ]);

  if (!entry) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1.5 text-xs fg-secondary"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {error !== undefined ? 'Unable to load folder.' : <LoadingSpinner />}
      </div>
    );
  }

  return (
    <>
      {entry.data.entries.map((child) => {
        if (child.kind === 'directory') {
          const expanded = expandedDirs.has(child.relativePath);
          return (
            <div key={child.relativePath}>
              <button
                type="button"
                onClick={(): void => onToggleDir(child.relativePath)}
                data-testid="file-breadcrumb-entry"
                data-entry-kind="directory"
                data-relative-path={child.relativePath}
                aria-expanded={expanded}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs fg-primary transition-colors hover:bg-fg-primary/[0.06]"
                style={{ paddingLeft: `${8 + depth * 14}px` }}
              >
                {expanded ? (
                  <ChevronDownIcon
                    size="sm"
                    className="shrink-0 fg-secondary"
                  />
                ) : (
                  <ChevronRightIcon
                    size="sm"
                    className="shrink-0 fg-secondary"
                  />
                )}
                <FolderIcon size="sm" className="shrink-0 fg-secondary" />
                <span className="min-w-0 truncate">{child.name}</span>
              </button>
              {expanded && (
                <BreadcrumbDirectory
                  projectId={projectId}
                  worktreeId={worktreeId}
                  repoId={repoId}
                  relativeDir={child.relativePath}
                  depth={depth + 1}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  highlightPath={highlightPath}
                  onPickFile={onPickFile}
                />
              )}
            </div>
          );
        }
        const highlighted = child.relativePath === highlightPath;
        return (
          <button
            key={child.relativePath}
            type="button"
            onClick={(): void => onPickFile(child)}
            data-testid="file-breadcrumb-entry"
            data-entry-kind="file"
            data-relative-path={child.relativePath}
            className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors hover:bg-fg-primary/[0.06] ${
              highlighted ? 'bg-accent-subtle fg-primary' : 'fg-primary'
            }`}
            style={{ paddingLeft: `${8 + depth * 14 + 16}px` }}
          >
            <FileTypeIcon
              filename={child.name}
              size="sm"
              className="shrink-0"
            />
            <span className="min-w-0 truncate">{child.name}</span>
          </button>
        );
      })}
    </>
  );
}

export function FilePathBreadcrumb({
  projectId,
  worktreeId,
  root,
  relativePath,
  onOpenFile,
}: FilePathBreadcrumbProps): JSX.Element {
  // The viewer's resolved root can outlive its initial read. Subscribe to
  // refreshed display metadata without reopening the file or changing paths.
  const refreshedRoot = useFileListStore((state) =>
    state.rootsCache[
      getWorktreeCacheKey(projectId, worktreeId)
    ]?.data.roots.find(
      (candidate) =>
        candidate.repoId === root.repoId &&
        candidate.absolutePath === root.absolutePath,
    ),
  );
  const rootName = refreshedRoot?.repoName ?? root.repoName;
  const openFileTab = useChatStore((s) => s.openFileTab);
  const [menu, setMenu] = useState<SegmentMenuState | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set(),
  );

  const parts = useMemo(
    () => relativePath.split('/').filter((part) => part.length > 0),
    [relativePath],
  );

  const openSegmentMenu = (
    segmentIndex: number,
    anchorEl: HTMLElement,
    baseDir: string,
    expandTarget: string | null,
  ): void => {
    setMenu((current) =>
      current?.segmentIndex === segmentIndex
        ? null
        : { segmentIndex, anchorEl, baseDir, expandTarget },
    );
    setExpandedDirs(
      expandTarget === null ? new Set() : new Set([expandTarget]),
    );
  };

  const closeMenu = useCallback((): void => setMenu(null), []);

  const handleToggleDir = (dirRelativePath: string): void => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(dirRelativePath)) {
        next.delete(dirRelativePath);
      } else {
        next.add(dirRelativePath);
      }
      return next;
    });
  };

  const handlePickFile = (entry: FileTreeEntry): void => {
    closeMenu();
    const file = { absolutePath: entry.absolutePath, filename: entry.name };
    if (onOpenFile) {
      onOpenFile(file);
    } else {
      openFileTab(file);
    }
  };

  // Stable RefObject identity (FloatingMenu keys effects on it); the live
  // anchor element is refreshed on every render.
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = menu?.anchorEl ?? null;
  // A press on another segment switches the menu instead of closing it, so
  // the whole breadcrumb is one outside-press boundary.
  const breadcrumbRef = useRef<HTMLDivElement | null>(null);
  const fileName = parts[parts.length - 1] ?? relativePath;
  const folderParts = parts.slice(0, -1);

  return (
    <div
      ref={breadcrumbRef}
      className="flex min-w-0 max-w-xl items-center gap-0.5 overflow-hidden whitespace-nowrap text-xs"
      data-testid="file-breadcrumb"
    >
      <span
        className="flex min-w-12 shrink-999 items-center gap-0.5 overflow-hidden"
        data-testid="file-breadcrumb-folders"
        onFocusCapture={(event): void => {
          // Keep a keyboard-focused folder visible in the clipped path strip.
          event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="compact"
          touchArea="contained"
          data-testid="file-breadcrumb-segment-root"
          className="max-w-40 min-w-0 shrink-0"
          onClick={(event): void =>
            openSegmentMenu(0, event.currentTarget, '', null)
          }
        >
          <span className="min-w-0 truncate">
            {isCoworkWorkspaceFileTreeRoot(root) ? (
              // The Cowork root carries the user's project title.
              <span className={REPLAY_MASK_CLASS}>{rootName}</span>
            ) : (
              rootName
            )}
          </span>
        </Button>
        {folderParts.map((part, index) => (
          <span
            key={`${index}-${part}`}
            className="flex shrink-0 items-center gap-0.5"
          >
            <ChevronRightIcon size="sm" className="shrink-0 fg-secondary/60" />
            <Button
              type="button"
              variant="ghost"
              size="compact"
              touchArea="contained"
              data-testid={`file-breadcrumb-segment-${index}`}
              className="max-w-40 min-w-0 shrink-0"
              onClick={(event): void =>
                openSegmentMenu(
                  index + 1,
                  event.currentTarget,
                  folderParts.slice(0, index).join('/'),
                  folderParts.slice(0, index + 1).join('/'),
                )
              }
            >
              <span className="min-w-0 truncate">{part}</span>
            </Button>
          </span>
        ))}
      </span>
      <ChevronRightIcon size="sm" className="shrink-0 fg-secondary/60" />
      <Button
        type="button"
        variant="ghost"
        size="compact"
        touchArea="contained"
        data-testid="file-breadcrumb-segment-file"
        className="min-w-0 max-w-64 shrink-1"
        onClick={(event): void =>
          openSegmentMenu(
            parts.length,
            event.currentTarget,
            folderParts.join('/'),
            null,
          )
        }
      >
        {/* The name can be cut off, so the text keeps a native title with the
            full name. */}
        <span className="min-w-0 truncate" title={fileName}>
          {fileName}
        </span>
      </Button>
      <FloatingMenu
        // Each segment's menu is its own: switching segments places it anew.
        key={menu?.segmentIndex ?? 'closed'}
        open={menu !== null}
        onOpenChange={(open): void => {
          if (!open) closeMenu();
        }}
        anchorRef={anchorRef}
        outsidePressBoundaryRef={breadcrumbRef}
        placement="bottom-left"
        // A folder tree of plain buttons, not menu rows: the menu keeps its
        // placement and dismissal and leaves focus and keys to the rows.
        interaction="manual"
        heightLimit={320}
        className="w-72 overflow-y-auto"
        data-testid="file-breadcrumb-menu"
      >
        {menu !== null && (
          <BreadcrumbDirectory
            projectId={projectId}
            worktreeId={worktreeId}
            repoId={root.repoId}
            relativeDir={menu.baseDir}
            depth={0}
            expandedDirs={expandedDirs}
            onToggleDir={handleToggleDir}
            highlightPath={relativePath}
            onPickFile={handlePickFile}
          />
        )}
      </FloatingMenu>
    </div>
  );
}
