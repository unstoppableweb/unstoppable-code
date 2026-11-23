import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  ChangedFilesSection as SharedChangedFilesSection,
  changedFilesHeaderSubtitle,
  type ChangedFileRow,
  type ChangedFilesSectionHostModel,
} from '@canopy/ui-app';
import type {
  RemoteControlChangedFile,
  RemoteControlChangedFiles,
} from '@canopy/protocol/remote-control/shell';
import type {
  ActivityChangedFilesResponse,
  TurnDiffData,
  ChangedFileInfo,
  FileDiffSource,
  FileTreeEntry,
  FileTreeRoot,
} from '@canopy/desktop-shared/types';
import { Button, HeaderActionButton } from '@canopy/ui-shared/components';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  ChangesIcon,
  ChangeDiagramIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  useActivitySectionChrome,
  type CollapsedIconColor,
} from '@/components/shared/panel-section';
import { FileLabelFilterDropdown } from '@/components/shared/FileLabelFilterDropdown';
import {
  useChangedFileLabelFilter,
  type ChangedFileLabelFilter,
} from '@/hooks/useChangedFileLabelFilter';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { openFileInDiff } from '@/lib/panels/open-file-diff';
import { openChangeDiagram } from '@/lib/panels/chat-panel-sync';
import { getWorktreeCacheKey, useFileListStore } from '@/stores/fileListStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { ActivitySection } from './ActivitySection';
import {
  FileTreeActionMenu,
  type FileTreeFileActionTarget,
  type FileTreeMenuAction,
} from './FileTreeActionMenu';
import { RevertConfirmModal } from './RevertConfirmModal';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';

const EMPTY_CHANGED_FILES: ActivityChangedFilesResponse = {
  uncommitted: [],
  committed: [],
};

// eslint-disable-next-line react-refresh/only-export-components
export function toRemoteControlFile(
  file: ChangedFileInfo,
): RemoteControlChangedFile {
  return {
    filePath: file.repoName ? `${file.repoName}/${file.path}` : file.path,
    status: file.status,
    renamedFrom:
      file.status === 'renamed' && file.previousPath
        ? file.repoName
          ? `${file.repoName}/${file.previousPath}`
          : file.previousPath
        : undefined,
    // A binary file has no line counts; the shared row says "Binary" instead.
    ...(file.binary === true
      ? { binary: true }
      : { insertions: file.insertions, deletions: file.deletions }),
    previousPath: file.previousPath,
    repoId: file.repoId,
  };
}

function toRemoteControlChangedFiles(
  changedFiles: ActivityChangedFilesResponse,
  worktreeId: string,
): RemoteControlChangedFiles {
  return {
    worktreeLocalId: worktreeId,
    uncommitted: changedFiles.uncommitted.map(toRemoteControlFile),
    committed: changedFiles.committed.map(toRemoteControlFile),
  };
}

function findNativeFile(
  files: readonly ChangedFileInfo[],
  row: ChangedFileRow,
): ChangedFileInfo | undefined {
  return files.find(
    (file) =>
      (file.repoName ? `${file.repoName}/${file.path}` : file.path) ===
        row.filePath &&
      file.status === row.status &&
      file.previousPath === row.previousPath &&
      file.repoId === row.repoId,
  );
}

function joinFileTreePath(root: FileTreeRoot, relativePath: string): string {
  const separator = root.absolutePath.includes('\\') ? '\\' : '/';
  const normalized = relativePath.replace(/[\\/]/g, separator);
  return `${root.absolutePath.replace(/[\\/]$/, '')}${separator}${normalized}`;
}

function basename(relativePath: string): string {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? relativePath;
}

function changedFileParentPath(
  root: FileTreeRoot,
  relativePath: string,
): string {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.length === 0
    ? root.absolutePath
    : joinFileTreePath(root, parts.join('/'));
}

interface ChangedFileActionTarget extends FileTreeFileActionTarget {
  changedFile: ChangedFileInfo;
  changedFileSource: FileDiffSource;
}

function changedFileActionTarget(
  file: ChangedFileInfo,
  source: FileDiffSource,
  roots: readonly FileTreeRoot[],
  point: { clientX: number; clientY: number },
): ChangedFileActionTarget | null {
  const gitRoots = roots.filter(
    (candidate) => candidate.rootKind === 'git-repo',
  );
  const root =
    roots.find((candidate) => candidate.repoId === file.repoId) ??
    (file.repoId === undefined && gitRoots.length === 1
      ? gitRoots[0]
      : undefined);
  if (!root) return null;
  const absolutePath = joinFileTreePath(root, file.path);
  const entry: FileTreeEntry = {
    name: basename(file.path),
    relativePath: file.path,
    absolutePath,
    kind: 'file',
    isIgnored: false,
    isIndexExcluded: false,
    isSymlink: false,
    hasChildren: false,
  };
  return {
    kind: 'file',
    entry,
    root,
    repoCount: roots.length,
    copyPath: file.path,
    x: point.clientX,
    y: point.clientY,
    node: {
      id: `${encodeURIComponent(root.repoId)}:${encodeURIComponent(file.path)}`,
      kind: 'file',
      name: entry.name,
      relativePath: file.path,
      absolutePath,
      root,
      repoCount: roots.length,
    },
    fileExists: file.status !== 'deleted',
    ...(file.status === 'deleted'
      ? { fileManagerPath: changedFileParentPath(root, file.path) }
      : {}),
    changedFile: file,
    changedFileSource: source,
  };
}

interface ChangedFilesSectionProps {
  uncommitted: ChangedFileInfo[];
  committed: ChangedFileInfo[];
  /** Stable reveal-budget scope for the shared Changed files list. */
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  onFileClick?: (file: ChangedFileInfo, source: FileDiffSource) => void;
  onRevertFile?: (file: ChangedFileInfo) => void;
  onReviewChanges?: () => void;
}

function getChangedFilesHeaderChrome(filter: ChangedFileLabelFilter): {
  subtitle: string;
  collapsedIconColor: CollapsedIconColor;
} {
  const total = filter.totalCount;
  return {
    // The shared header, so desktop and web word it identically (REG-3024).
    subtitle: changedFilesHeaderSubtitle({
      totalCount: total,
      visibleCount: filter.visibleCount,
    }),
    collapsedIconColor: total > 0 ? 'amber' : 'muted',
  };
}

interface ChangedFilesFilterChrome {
  filter: ChangedFileLabelFilter;
  /** Filter dropdown for the section header (undefined when no files). */
  filterAction: ReactNode;
  /** Muted "N more files…" row that reopens the filter menu. */
  moreFilesRow: ReactNode;
}

/** Shared filter chrome for both changed-files section variants. */
function useChangedFilesFilterChrome(
  uncommitted: readonly ChangedFileInfo[],
  committed: readonly ChangedFileInfo[],
): ChangedFilesFilterChrome {
  const filter = useChangedFileLabelFilter(uncommitted, committed);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  const filterAction =
    filter.totalCount > 0 ? (
      <FileLabelFilterDropdown
        options={filter.options}
        hiddenLabelIds={filter.hiddenLabelIds}
        onChange={filter.setHiddenLabelIds}
        open={filterMenuOpen}
        onOpenChange={setFilterMenuOpen}
        testIdPrefix="changed-files-label-filter"
        activityCardTrigger
      />
    ) : undefined;

  const moreFilesRow =
    filter.hiddenCount > 0 ? (
      // The shared Changed Files list's "Show N more files" control: a small
      // ghost button at the list's start edge.
      <div className="flex flex-col items-start">
        <Button
          variant="ghost"
          size="sm"
          data-testid="changed-files-more-files"
          onClick={() => setFilterMenuOpen(true)}
        >
          {`${filter.hiddenCount} more file${filter.hiddenCount === 1 ? '' : 's'}…`}
        </Button>
      </div>
    ) : null;

  return { filter, filterAction, moreFilesRow };
}

export function ChangedFilesSection({
  uncommitted,
  committed,
  workspaceLocalId,
  worktreeLocalId,
  onFileClick,
  onRevertFile,
  onReviewChanges,
}: ChangedFilesSectionProps): JSX.Element {
  const chrome = useActivitySectionChrome();
  const title = useEarlyAccessTitle('Changed Files');
  const { filter, filterAction, moreFilesRow } = useChangedFilesFilterChrome(
    uncommitted,
    committed,
  );
  const headerChrome = getChangedFilesHeaderChrome(filter);
  const scope = useMemo(
    () => ({
      workspaceLocalId: workspaceLocalId ?? 'native-standalone',
      worktreeLocalId: worktreeLocalId ?? 'native-standalone',
    }),
    [workspaceLocalId, worktreeLocalId],
  );
  const changedFiles = useMemo(
    () =>
      toRemoteControlChangedFiles(
        {
          uncommitted: filter.visibleUncommitted,
          committed: filter.visibleCommitted,
        },
        scope.worktreeLocalId,
      ),
    [filter.visibleCommitted, filter.visibleUncommitted, scope],
  );

  return (
    // In body-only chrome the shared section wrapper carries this testid (via
    // the adapter's dataTestId override) so header-subtitle assertions land
    // inside it; emitting it here too would duplicate the id.
    <div
      data-testid={chrome === 'body-only' ? undefined : 'changed-files-section'}
    >
      <ActivitySection
        icon={<ChangesIcon size={16} />}
        title={title}
        subtitle={headerChrome.subtitle}
        collapsedIconColor={headerChrome.collapsedIconColor}
        headerAction={
          (filterAction ?? onReviewChanges) ? (
            <div className="flex items-center gap-1">
              {filterAction}
              {onReviewChanges && (
                <HeaderActionButton
                  iconOnly
                  data-testid="view-change-diagram-button"
                  aria-label="View diagram"
                  onClick={(e): void => {
                    e.stopPropagation();
                    onReviewChanges();
                  }}
                >
                  <ChangeDiagramIcon size="sm" />
                </HeaderActionButton>
              )}
            </div>
          ) : undefined
        }
      >
        <SharedChangedFilesSection
          changedFiles={changedFiles}
          canRevert={onRevertFile !== undefined}
          emptyState={null}
          scrollable={chrome !== 'frameless'}
          workspaceLocalId={scope.workspaceLocalId}
          worktreeLocalId={scope.worktreeLocalId}
          onFileClick={
            onFileClick
              ? (row): void => {
                  const files =
                    row.source === 'uncommitted' ? uncommitted : committed;
                  const file = findNativeFile(files, row);
                  if (file) onFileClick(file, row.source);
                }
              : undefined
          }
          onRevertFile={
            onRevertFile
              ? (row): void => {
                  const file = findNativeFile(uncommitted, row);
                  if (file) onRevertFile(file);
                }
              : undefined
          }
        />
        {moreFilesRow}
      </ActivitySection>
    </div>
  );
}

/**
 * Desktop-only extension for chrome owned by the native section container.
 * These fields are stripped before the neutral model reaches ActivityPanel.
 */
export interface DesktopChangedFilesSectionModel extends ChangedFilesSectionHostModel {
  readonly headerAction?: ReactNode;
  /**
   * Filter-aware header counter. The model's `changedFiles` lists are already
   * label-filtered, so the header cannot re-derive the true total from them.
   */
  readonly headerSubtitle?: string;
  /** Unfiltered file count driving the collapsed icon color. */
  readonly totalFileCount?: number;
}

export function ChangedFilesHostSection({
  model,
}: {
  model: DesktopChangedFilesSectionModel;
}): JSX.Element {
  const chrome = useActivitySectionChrome();
  const title = useEarlyAccessTitle('Changed Files');
  const {
    headerAction,
    headerSubtitle,
    totalFileCount,
    supplementaryContent,
    ...bodyProps
  } = model;
  const total =
    totalFileCount ??
    (bodyProps.changedFiles?.uncommitted.length ?? 0) +
      (bodyProps.changedFiles?.committed.length ?? 0);
  const subtitle =
    headerSubtitle ??
    (total === 0
      ? 'No local changes'
      : `${total} file${total === 1 ? '' : 's'}`);
  // In body-only chrome the shared section wrapper carries the container
  // testid (via the adapter's dataTestId override); emitting it here too
  // would duplicate the id.
  const sectionTestId =
    chrome === 'body-only' ? undefined : 'changed-files-section';
  return (
    // In a standalone (frameless) activity-card panel the section root must be a
    // filling flex column so PanelSection's `h-full` frameless body resolves to
    // a bounded height and its `overflow-y-auto` actually scrolls a long list
    // (matching SummarySection/PlansSection). Without this the list overflows
    // the panel with no scroll.
    <div
      data-testid={sectionTestId}
      className={
        chrome === 'frameless' ? 'flex min-h-0 flex-1 flex-col' : undefined
      }
    >
      <ActivitySection
        icon={<ChangesIcon size={16} />}
        title={title}
        subtitle={subtitle}
        collapsedIconColor={total > 0 ? 'amber' : 'muted'}
        headerAction={headerAction}
      >
        <SharedChangedFilesSection {...bodyProps} />
        {supplementaryContent}
      </ActivitySection>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useChangedFilesSectionHostModel({
  projectId,
  worktreeId,
  originFileTabId,
  diffTree = false,
  turnDiff,
}: {
  projectId: string;
  worktreeId: string;
  originFileTabId?: string;
  diffTree?: boolean;
  turnDiff?: TurnDiffData;
}): DesktopChangedFilesSectionModel {
  // The shared-container recipient reads the published diff; nothing reverts.
  const readOnly = useWorkspaceIsReadOnly();
  const chrome = useActivitySectionChrome();
  const worktreeKey = `${projectId}/${worktreeId}`;
  const liveChangedFiles = useActivityStore(
    (state): ActivityChangedFilesResponse =>
      state.changedFiles[worktreeKey] ?? EMPTY_CHANGED_FILES,
  );
  const [revertTarget, setRevertTarget] = useState<ChangedFileInfo | null>(
    null,
  );
  const [reverting, setReverting] = useState(false);
  const changedFiles = useMemo(
    () =>
      turnDiff
        ? { uncommitted: turnDiff.files, committed: [] }
        : liveChangedFiles,
    [turnDiff, liveChangedFiles],
  );
  const [revertError, setRevertError] = useState<string | null>(null);
  // Main already recorded that revert IPC failure, so the dialog does not
  // record it again. Reset with `revertError`.
  const [revertErrorRecorded, setRevertErrorRecorded] = useState(false);
  const [actionTarget, setActionTarget] =
    useState<ChangedFileActionTarget | null>(null);
  const contextMenuRequestRef = useRef(0);

  useEffect(() => {
    contextMenuRequestRef.current += 1;
    setActionTarget(null);
    return (): void => {
      contextMenuRequestRef.current += 1;
    };
  }, [projectId, worktreeId]);

  const handleFileClick = useCallback(
    (row: ChangedFileRow): void => {
      const files =
        row.source === 'uncommitted'
          ? changedFiles.uncommitted
          : changedFiles.committed;
      const file = findNativeFile(files, row);
      if (!file) return;
      void openFileInDiff(
        { projectId, worktreeId },
        file,
        row.source,
        {
          fileTabId: originFileTabId,
        },
        turnDiff,
      );
    },
    [changedFiles, originFileTabId, projectId, worktreeId, turnDiff],
  );

  const handleReviewChanges = useCallback((): void => {
    void openChangeDiagram(
      `${projectId}/${worktreeId}`,
      originFileTabId ? { fileTabId: originFileTabId } : undefined,
    );
  }, [originFileTabId, projectId, worktreeId]);

  const handleFileContextMenu = useCallback(
    (
      row: ChangedFileRow,
      point: { clientX: number; clientY: number },
    ): void => {
      const request = ++contextMenuRequestRef.current;
      const files =
        row.source === 'uncommitted'
          ? changedFiles.uncommitted
          : changedFiles.committed;
      const file = findNativeFile(files, row);
      if (!file) return;
      const openFromRoots = (roots: readonly FileTreeRoot[]): void => {
        if (contextMenuRequestRef.current !== request) return;
        const target = changedFileActionTarget(file, row.source, roots, point);
        if (target) setActionTarget(target);
      };
      const fileList = useFileListStore.getState();
      const cacheKey = getWorktreeCacheKey(projectId, worktreeId);
      const cachedRoots = fileList.rootsCache[cacheKey]?.data.roots;
      if (cachedRoots) {
        openFromRoots(cachedRoots);
        return;
      }
      void fileList.fetchFileTreeRoots(projectId, worktreeId).then(() => {
        const roots =
          useFileListStore.getState().rootsCache[cacheKey]?.data.roots;
        if (roots) openFromRoots(roots);
      });
    },
    [changedFiles, projectId, worktreeId],
  );

  const handleOpenInFileManager = useCallback(
    (absolutePath: string): void => {
      void window.api.showInFinder({
        absolutePath,
        projectId,
        worktreeId,
      });
    },
    [projectId, worktreeId],
  );

  const openFileTarget = useCallback(
    (target: ChangedFileActionTarget): void => {
      if (target.fileExists === false) {
        void openFileInDiff(
          { projectId, worktreeId },
          target.changedFile,
          target.changedFileSource,
        );
        return;
      }
      useChatStore.getState().openFileTab({
        absolutePath: target.entry.absolutePath,
        filename: target.entry.name,
      });
    },
    [projectId, worktreeId],
  );

  const handleFileAction = useCallback(
    (action: FileTreeMenuAction, target: ChangedFileActionTarget): void => {
      if (target.kind !== 'file') return;
      if (action === 'open') {
        openFileTarget(target);
        return;
      }
    },
    [openFileTarget],
  );

  const handleOpenInApp = useCallback(
    (appId: string): void => {
      void window.api.openInApp({ projectId, worktreeId, appId });
      void window.api.savePreferences({ lastOpenApp: appId });
    },
    [projectId, worktreeId],
  );

  const handleRevertClick = useCallback(
    (row: ChangedFileRow): void => {
      const file = findNativeFile(changedFiles.uncommitted, row);
      if (!file) return;
      setRevertTarget(file);
      setRevertError(null);
      setRevertErrorRecorded(false);
    },
    [changedFiles.uncommitted],
  );

  const handleRevertCancel = useCallback((): void => {
    setRevertTarget(null);
    setRevertError(null);
    setRevertErrorRecorded(false);
  }, []);

  const handleRevertConfirm = useCallback((): void => {
    if (!revertTarget) return;
    setReverting(true);
    setRevertError(null);
    setRevertErrorRecorded(false);
    void window.api.activity
      .revertFile({
        projectId,
        worktreeId,
        filePath: revertTarget.path,
        status: revertTarget.status,
        previousPath: revertTarget.previousPath,
        repoId: revertTarget.repoId,
      })
      .then(() => {
        setRevertTarget(null);
        void Promise.all([
          useProjectsStore
            .getState()
            .refreshWorktreeDiffStats(projectId, worktreeId)
            .catch(() => undefined),
        ]).then(() => {
          void useGitHubStore
            .getState()
            .requestFastRefresh(projectId, worktreeId);
        });
      })
      .catch((error: unknown) => {
        setRevertErrorRecorded(
          toAppError(resolveClientAppError(error))?.recordedBy !== undefined,
        );
        setRevertError(
          error instanceof Error ? error.message : 'Failed to revert file',
        );
      })
      .finally(() => {
        setReverting(false);
      });
  }, [projectId, revertTarget, worktreeId]);

  const { filter, filterAction, moreFilesRow } = useChangedFilesFilterChrome(
    changedFiles.uncommitted,
    changedFiles.committed,
  );
  const scope = useMemo(
    () => ({ workspaceLocalId: projectId, worktreeLocalId: worktreeId }),
    [projectId, worktreeId],
  );
  const remoteControlChangedFiles = useMemo(
    () =>
      toRemoteControlChangedFiles(
        {
          uncommitted: filter.visibleUncommitted,
          committed: filter.visibleCommitted,
        },
        scope.worktreeLocalId,
      ),
    [filter.visibleCommitted, filter.visibleUncommitted, scope],
  );
  const total = filter.totalCount;

  return {
    changedFiles: remoteControlChangedFiles,
    workspaceLocalId: scope.workspaceLocalId,
    worktreeLocalId: scope.worktreeLocalId,
    canRevert: !readOnly,
    emptyState: null,
    // In a standalone (frameless) activity-card panel the PanelSection body
    // owns the scroll and fills the panel height; keeping the inner 280px cap
    // there would trap long file lists in a nested scroller. In card/body-only
    // chrome the inner cap keeps one section from dominating the stacked panel.
    scrollable: chrome !== 'frameless',
    onFileClick: handleFileClick,
    ...(readOnly ? {} : { onFileContextMenu: handleFileContextMenu }),
    ...(readOnly ? {} : { onRevertFile: handleRevertClick }),
    headerSubtitle: changedFilesHeaderSubtitle({
      totalCount: total,
      visibleCount: filter.visibleCount,
    }),
    totalFileCount: total,
    headerAction: diffTree ? (
      filterAction
    ) : total > 0 ? (
      readOnly ? (
        filterAction
      ) : (
        <div className="flex items-center gap-1">
          {filterAction}
          <HeaderActionButton
            iconOnly
            data-testid="view-change-diagram-button"
            aria-label="View diagram"
            onClick={(event): void => {
              event.stopPropagation();
              handleReviewChanges();
            }}
          >
            <ChangeDiagramIcon size="sm" />
          </HeaderActionButton>
        </div>
      )
    ) : undefined,
    supplementaryContent: (
      <>
        {moreFilesRow}
        {!readOnly && actionTarget ? (
          <FileTreeActionMenu
            target={actionTarget}
            onClose={() => setActionTarget(null)}
            onOpenInFileManager={handleOpenInFileManager}
            onAction={(action) => handleFileAction(action, actionTarget)}
            onOpenInApp={handleOpenInApp}
            canPaste={false}
            variant={diffTree ? 'diff-tree' : 'changed-file'}
          />
        ) : null}
        {revertTarget ? (
          <RevertConfirmModal
            file={revertTarget}
            projectId={projectId}
            worktreeId={worktreeId}
            reverting={reverting}
            error={revertError}
            errorRecorded={revertErrorRecorded}
            onConfirm={handleRevertConfirm}
            onCancel={handleRevertCancel}
          />
        ) : null}
      </>
    ),
  };
}
