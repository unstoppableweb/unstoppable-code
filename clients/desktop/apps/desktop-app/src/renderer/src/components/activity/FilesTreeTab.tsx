import { EmbeddedFileTreeToolbar } from './EmbeddedFileTreeToolbar';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type UIEvent,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { ConfirmDialog } from '@canopy/ui-shared';
import type {
  FileTreeEntry,
  FileTreeItemReference,
  FileTreeRoot,
} from '@canopy/desktop-shared/types';
import {
  Stack,
  Surface,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';
import {
  acquireFileTreeWatch,
  releaseFileTreeWatch,
} from '@/lib/file-tree-watch';
import { requestFilePanelPlacementBesideChat } from '@/lib/panels/chat-panel-sync';
import { usePanelHostState } from '@/lib/panels/panel-host-context';
import { useChatStore } from '@/stores/chatStore';
import { worktreeKey } from '@/stores/chat/utils';
import {
  getDirectoryCacheKey,
  getFileTreeIndexCacheKey,
  getFileTreeUiStateKey,
  getWorktreeCacheKey,
  useFileListStore,
  useRetainFileIndex,
} from '@/stores/fileListStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  FILE_TREE_SET_SEARCH_EVENT,
  isFileTreeSetSearchDetail,
} from '@/lib/fileTreeSearchEvents';
import {
  APP_MANAGED_ROOTS_NODE_ID,
  APP_MANAGED_ROOTS_TREE_PATH,
  buildFilteredFileTree,
  getAutoExpandRepoPath,
  getDirectoryTreePath,
  getRepoTreePath,
  isCoworkWorkspaceFileTreeRoot,
  isVisibleExpandedTreePath,
  normalizeFileTreeSearchQuery,
  partitionFileTreeRoots,
  shouldFetchFilesTreeDirectory,
  shouldFetchFilesTreeIndex,
  shouldFetchFilesTreeRoots,
  FILE_TREE_SEARCH_DEBOUNCE_MS,
  FILE_TREE_SEARCH_RESULT_LIMIT,
  type FilteredFileTreeNode,
} from './files-tree-tab-state';
import { FileTypeIcon } from '@canopy/ui-shared/icons';
import {
  FieldError,
  FileRootGroupRow,
  FileTreeRow,
  FilesTreeRefreshButton,
  ErrorBanner,
  ErrorState,
  SearchField,
  StatusLabel,
  TextInput,
} from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import { Tooltip } from '@canopy/ui-shared';
import { FolderIcon } from '@canopy/ui-shared/icons';
// Search/close glyphs come from the canonical app icon API (the same
// source the panel registry and top-level shell use); the barrel above has no
// equivalent export.
import {
  CloseIcon,
  ChevronUp,
  FocusSquareIcon,
  FolderPlusIcon,
  PlusIcon,
  SearchIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import {
  FileTreeActionMenu,
  type FileTreeActionMenuProps,
  type FileTreeActionNode,
  type FileTreeActionTarget,
  type FileTreeFileActionTarget,
  type FileTreeFolderActionTarget,
} from './FileTreeActionMenu';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStartPageStore } from '@/stores/startPageStore';
import { useCanopyDesktopStartPageEnabled } from '@/hooks/useCanopyDesktopStartPageEnabled';
import {
  startPageFromAbsolutePath,
  startPagesEqual,
} from '@/lib/start-page/project-start-page';
import { saveStartPageFromAction } from '@/lib/start-page/save-start-page';
import { Button } from '@canopy/ui-shared/components';

const EMPTY_EXPANDED_PATHS = new Set<string>();
const DRAG_AUTO_EXPAND_DELAY_MS = 500;

type ExplorerNode = FileTreeActionNode;

interface CurrentFileTreeTarget {
  nodeId: string;
  expandedPaths: Set<string>;
}

type FileTreeTargetKind = 'file' | 'directory';

type InlineEditorMode = 'create-file' | 'create-directory' | 'rename';

interface InlineEditorState {
  mode: InlineEditorMode;
  node: ExplorerNode;
  value: string;
}

function inlineEditorParentPath(editor: InlineEditorState): string {
  if (editor.mode === 'rename') {
    return editor.node.relativePath.split('/').slice(0, -1).join('/');
  }
  return editor.node.kind === 'folder'
    ? editor.node.relativePath
    : editor.node.relativePath.split('/').slice(0, -1).join('/');
}

function isCaseInsensitiveRootPath(rootPath: string): boolean {
  const normalizedRoot = rootPath.replace(/\\/g, '/');
  return /^[a-z]:\//i.test(normalizedRoot) || normalizedRoot.startsWith('//');
}

function normalizeTreeRelativePath(
  root: Pick<FileTreeRoot, 'absolutePath'>,
  relativePath: string,
): string {
  return isCaseInsensitiveRootPath(root.absolutePath)
    ? relativePath.toLowerCase()
    : relativePath;
}

function directoryTreePath(
  root: Pick<FileTreeRoot, 'repoId' | 'absolutePath'>,
  relativePath: string,
): string {
  return getDirectoryTreePath(
    root.repoId,
    normalizeTreeRelativePath(root, relativePath),
  );
}

function explorerNodeId(
  root: Pick<FileTreeRoot, 'repoId' | 'absolutePath'>,
  relativePath: string,
): string {
  return `${encodeURIComponent(root.repoId)}:${encodeURIComponent(
    normalizeTreeRelativePath(root, relativePath),
  )}`;
}

function pathInsideRoot(filePath: string, rootPath: string): string | null {
  const caseInsensitive = isCaseInsensitiveRootPath(rootPath);
  const normalize = (value: string): string =>
    (caseInsensitive ? value.replace(/\\/g, '/') : value).replace(/\/+$/, '');
  const normalizedFilePath = normalize(filePath);
  const normalizedRoot = normalize(rootPath);
  const comparableFilePath = caseInsensitive
    ? normalizedFilePath.toLowerCase()
    : normalizedFilePath;
  const comparableRoot = caseInsensitive
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  if (comparableFilePath === comparableRoot) return '';
  if (!comparableFilePath.startsWith(`${comparableRoot}/`)) return null;
  return normalizedFilePath.slice(normalizedRoot.length + 1);
}

function resolveFileTreeTarget(
  targetPath: string | undefined,
  roots: readonly FileTreeRoot[],
  kind: FileTreeTargetKind,
): CurrentFileTreeTarget | null {
  if (!targetPath) return null;
  const match = roots
    .map((root) => ({
      root,
      relativePath: pathInsideRoot(targetPath, root.absolutePath),
    }))
    .filter(
      (candidate): candidate is { root: FileTreeRoot; relativePath: string } =>
        candidate.relativePath !== null,
    )
    .sort(
      (left, right) =>
        right.root.absolutePath.length - left.root.absolutePath.length,
    )[0];
  if (!match) return null;

  const expandedPaths = new Set<string>([getRepoTreePath(match.root)]);
  if (partitionFileTreeRoots(roots).appManaged.includes(match.root)) {
    expandedPaths.add(APP_MANAGED_ROOTS_TREE_PATH);
  }
  const pathSegments = match.relativePath.split('/').filter(Boolean);
  const directorySegments =
    kind === 'directory' ? pathSegments : pathSegments.slice(0, -1);
  for (let index = 0; index < directorySegments.length; index += 1) {
    expandedPaths.add(
      directoryTreePath(
        match.root,
        directorySegments.slice(0, index + 1).join('/'),
      ),
    );
  }
  return {
    nodeId: explorerNodeId(match.root, match.relativePath),
    expandedPaths,
  };
}

function isFullyVisibleInScrollContainer(
  element: HTMLElement,
  container: HTMLElement,
): boolean {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return (
    elementRect.top >= containerRect.top &&
    elementRect.bottom <= containerRect.bottom
  );
}

function nodeReference(node: ExplorerNode): FileTreeItemReference {
  return { repoId: node.root.repoId, relativePath: node.relativePath };
}

function topLevelMutationNodes(nodes: readonly ExplorerNode[]): ExplorerNode[] {
  return nodes.filter(
    (candidate) =>
      !nodes.some(
        (parent) =>
          parent.id !== candidate.id &&
          parent.kind === 'folder' &&
          parent.root.repoId === candidate.root.repoId &&
          candidate.relativePath.startsWith(`${parent.relativePath}/`),
      ),
  );
}

interface ExplorerInteractionValue {
  selectedIds: ReadonlySet<string>;
  focusedId: string | null;
  currentFileId: string | null;
  /**
   * Host override for opening a file from the tree (embedded per-file-tab
   * trees route the click into their own tab). Absent → the default
   * `chatStore.openFileTab` behavior.
   */
  openFile?: (file: { absolutePath: string; filename: string }) => void;
  activate: (
    node: ExplorerNode,
    event: MouseEvent<HTMLButtonElement>,
    defaultAction: () => void,
  ) => void;
  openContextMenu: (
    node: ExplorerNode,
    event: MouseEvent<HTMLButtonElement>,
    target: FileTreeActionTarget,
  ) => void;
  keyDown: (
    node: ExplorerNode,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  dragStart: (node: ExplorerNode, event: DragEvent<HTMLButtonElement>) => void;
  dragOver: (node: ExplorerNode, event: DragEvent<HTMLButtonElement>) => void;
  dragLeave: (node: ExplorerNode, event: DragEvent<HTMLButtonElement>) => void;
  drop: (node: ExplorerNode, event: DragEvent<HTMLButtonElement>) => void;
  dragEnd: () => void;
  dropTargetId: string | null;
  remember: (node: ExplorerNode) => () => void;
  inlineEditor: InlineEditorState | null;
  mutationBusy: boolean;
  mutationError: string | null;
  updateInlineEditor: (value: string) => void;
  submitInlineEditor: () => Promise<boolean>;
  cancelInlineEditor: () => void;
}

const ExplorerInteractionContext =
  createContext<ExplorerInteractionValue | null>(null);

interface InlineTreeEditorRowProps {
  editor: InlineEditorState;
  depth: number;
}

function InlineTreeEditorRow({
  editor,
  depth,
}: InlineTreeEditorRowProps): JSX.Element {
  const interaction = useContext(ExplorerInteractionContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const cancelledRef = useRef(false);
  const inFlightRef = useRef(false);
  const isDirectory =
    editor.mode === 'create-directory' ||
    (editor.mode === 'rename' && editor.node.kind === 'folder');

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (
      !interaction ||
      interaction.mutationBusy ||
      cancelledRef.current ||
      inFlightRef.current
    ) {
      return;
    }
    inFlightRef.current = true;
    try {
      const created = await interaction.submitInlineEditor();
      if (!created) {
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [interaction]);

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      className="flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-xs fg-primary"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      data-testid="files-tree-inline-editor-container"
      data-parent-path={inlineEditorParentPath(editor)}
      data-create-kind={
        editor.mode === 'create-file'
          ? 'file'
          : editor.mode === 'create-directory'
            ? 'directory'
            : undefined
      }
    >
      <span className="w-3 shrink-0" aria-hidden="true" />
      {isDirectory ? (
        <FolderIcon className="mt-0.5 shrink-0 fg-secondary" />
      ) : (
        <span className="mt-0.5 shrink-0">
          <FileTypeIcon filename={editor.value || 'untitled'} size="sm" />
        </span>
      )}
      <Stack gap="tight" className="min-w-0 flex-1">
        <TextInput
          ref={inputRef}
          density="compact"
          value={editor.value}
          disabled={interaction?.mutationBusy}
          aria-invalid={interaction?.mutationError ? true : undefined}
          aria-describedby={interaction?.mutationError ? errorId : undefined}
          data-testid="files-tree-inline-editor"
          aria-label={
            editor.mode === 'rename'
              ? 'New name'
              : editor.mode === 'create-file'
                ? 'New file name'
                : 'New folder name'
          }
          onChange={(event) =>
            interaction?.updateInlineEditor(event.target.value)
          }
          onBlur={() => {
            if (editor.mode !== 'rename' && editor.value.trim().length === 0) {
              cancelledRef.current = true;
              interaction?.cancelInlineEditor();
              return;
            }
            void submit();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelledRef.current = true;
              interaction?.cancelInlineEditor();
            }
          }}
        />
        {interaction?.mutationError && (
          <FieldError id={errorId} announce>
            {interaction.mutationError}
          </FieldError>
        )}
      </Stack>
    </div>
  );
}

interface FolderRowProps {
  label: string;
  depth: number;
  expanded: boolean;
  isRepo: boolean;
  isIgnored?: boolean;
  onToggle: () => void;
  copyPath?: string;
  absolutePath?: string;
  onActionMenu?: (target: FileTreeFolderActionTarget) => void;
  onOpenInFileManager: (absolutePath: string) => void;
  root?: FileTreeRoot;
  repoCount?: number;
  relativePath?: string;
  /** Mask the label in session replays, e.g. for a project title. */
  replayMaskLabel?: boolean;
}

function FolderRow({
  label,
  replayMaskLabel,
  depth,
  expanded,
  isRepo,
  isIgnored,
  onToggle,
  copyPath,
  absolutePath,
  onActionMenu,
  onOpenInFileManager,
  root,
  repoCount = 1,
  relativePath = '',
}: FolderRowProps): JSX.Element {
  const interaction = useContext(ExplorerInteractionContext);
  const node = useMemo<ExplorerNode | null>(
    () =>
      root && absolutePath
        ? {
            id: explorerNodeId(root, relativePath),
            kind: 'folder',
            name: label,
            relativePath,
            absolutePath,
            root,
            repoCount,
          }
        : null,
    [absolutePath, label, relativePath, repoCount, root],
  );
  useLayoutEffect(
    () => (node && interaction ? interaction.remember(node) : undefined),
    [interaction, node],
  );
  // Every folder header is a sticky stacking header (VS Code Explorer sticky
  // scroll). The FilesTreeTab scroll container flags which of them are actually
  // pinned via `data-stuck`.
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      if (!copyPath || !absolutePath || !onActionMenu) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      let targetNode = node;
      if (!targetNode) {
        if (!root) return;
        targetNode = {
          id: '',
          kind: 'folder',
          name: label,
          relativePath,
          absolutePath,
          root,
          repoCount,
        };
      }
      const target: FileTreeFolderActionTarget = {
        kind: 'folder',
        copyPath,
        absolutePath,
        x: event.clientX,
        y: event.clientY,
        node: targetNode,
      };
      if (interaction && node) {
        interaction.openContextMenu(node, event, target);
      } else {
        onActionMenu(target);
      }
    },
    [
      absolutePath,
      copyPath,
      interaction,
      label,
      node,
      onActionMenu,
      relativePath,
      repoCount,
      root,
    ],
  );

  if (
    node &&
    interaction?.inlineEditor?.mode === 'rename' &&
    interaction.inlineEditor.node.id === node.id
  ) {
    return (
      <InlineTreeEditorRow editor={interaction.inlineEditor} depth={depth} />
    );
  }

  return (
    <FileTreeRow
      label={label}
      replayMaskLabel={replayMaskLabel}
      depth={depth}
      isDirectory
      expanded={expanded}
      isRepoRoot={isRepo}
      isIgnored={isIgnored}
      onClick={(event) =>
        interaction && node
          ? interaction.activate(node, event, onToggle)
          : onToggle()
      }
      onContextMenu={
        copyPath && absolutePath && onActionMenu ? handleContextMenu : undefined
      }
      dataTestId="files-tree-folder"
      dataPath={relativePath}
      dataNodeId={node?.id}
      ariaSelected={node ? interaction?.selectedIds.has(node.id) : undefined}
      selected={node ? interaction?.selectedIds.has(node.id) : false}
      tabIndex={node?.id === interaction?.focusedId ? 0 : -1}
      onKeyDown={
        node ? (event): void => interaction?.keyDown(node, event) : undefined
      }
      draggable={Boolean(node && relativePath)}
      onDragStart={
        node ? (event): void => interaction?.dragStart(node, event) : undefined
      }
      onDragOver={
        node ? (event): void => interaction?.dragOver(node, event) : undefined
      }
      onDragLeave={
        node ? (event): void => interaction?.dragLeave(node, event) : undefined
      }
      onDrop={
        node ? (event): void => interaction?.drop(node, event) : undefined
      }
      onDragEnd={interaction?.dragEnd}
      dropTarget={node?.id === interaction?.dropTargetId}
      sticky
      trailingAction={
        absolutePath ? (
          <Tooltip label={pt(uiText.fileManager.openItem)}>
            <Button
              variant="ghost-quiet"
              size="sm"
              iconOnly
              data-testid="files-tree-row-open-in-file-manager"
              aria-label={pt(uiText.fileManager.openItem)}
              onClick={(event): void => {
                event.preventDefault();
                event.stopPropagation();
                onOpenInFileManager(absolutePath);
              }}
            >
              <FolderIcon size="sm" />
            </Button>
          </Tooltip>
        ) : undefined
      }
    />
  );
}

interface FileNodeRowProps {
  entry: FileTreeEntry;
  root: FileTreeRoot;
  repoCount: number;
  depth: number;
  onActionMenu: (target: FileTreeActionTarget) => void;
  onOpenInFileManager: (absolutePath: string) => void;
}

const FileNodeRow = memo(function FileNodeRow({
  entry,
  root,
  repoCount,
  depth,
  onActionMenu,
  onOpenInFileManager,
}: FileNodeRowProps): JSX.Element {
  const interaction = useContext(ExplorerInteractionContext);
  const openFileTab = useChatStore((s) => s.openFileTab);
  const node = useMemo<ExplorerNode>(
    () => ({
      id: explorerNodeId(root, entry.relativePath),
      kind: 'file',
      name: entry.name,
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
      root,
      repoCount,
    }),
    [entry, repoCount, root],
  );
  useLayoutEffect(() => interaction?.remember(node), [interaction, node]);
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      const open = (): void => {
        const file = {
          absolutePath: entry.absolutePath,
          filename: entry.name,
        };
        if (interaction?.openFile) {
          interaction.openFile(file);
        } else {
          openFileTab(file);
        }
      };
      if (interaction) interaction.activate(node, event, open);
      else open();
    },
    [entry.absolutePath, entry.name, interaction, node, openFileTab],
  );

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      const target: FileTreeFileActionTarget = {
        kind: 'file',
        entry,
        root,
        repoCount,
        copyPath: entry.relativePath,
        x: event.clientX,
        y: event.clientY,
        node,
      };
      if (interaction) interaction.openContextMenu(node, event, target);
      else onActionMenu(target);
    },
    [entry, interaction, node, onActionMenu, repoCount, root],
  );

  if (
    interaction?.inlineEditor?.mode === 'rename' &&
    interaction.inlineEditor.node.id === node.id
  ) {
    return (
      <InlineTreeEditorRow editor={interaction.inlineEditor} depth={depth} />
    );
  }

  const dimmed = entry.isIgnored;
  const isCurrentFile = interaction?.currentFileId === node.id;
  return (
    <FileTreeRow
      label={entry.name}
      depth={depth}
      isDirectory={false}
      isIgnored={dimmed}
      title={entry.absolutePath}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      dataTestId="files-tree-row"
      dataPath={entry.relativePath}
      dataNodeId={node.id}
      ariaSelected={interaction?.selectedIds.has(node.id)}
      selected={interaction?.selectedIds.has(node.id)}
      current={isCurrentFile}
      tabIndex={node.id === interaction?.focusedId ? 0 : -1}
      onKeyDown={(event) => interaction?.keyDown(node, event)}
      draggable
      onDragStart={(event) => interaction?.dragStart(node, event)}
      onDragOver={(event) => interaction?.dragOver(node, event)}
      onDragLeave={(event) => interaction?.dragLeave(node, event)}
      onDrop={(event) => interaction?.drop(node, event)}
      onDragEnd={interaction?.dragEnd}
      dropTarget={node.id === interaction?.dropTargetId}
      trailingAction={
        <Tooltip label={pt(uiText.fileManager.openItem)}>
          <Button
            variant="ghost-quiet"
            size="sm"
            iconOnly
            data-testid="files-tree-row-open-in-file-manager"
            aria-label={pt(uiText.fileManager.openItem)}
            onClick={(event): void => {
              event.preventDefault();
              event.stopPropagation();
              onOpenInFileManager(entry.absolutePath);
            }}
          >
            <FolderIcon size="sm" />
          </Button>
        </Tooltip>
      }
    />
  );
});

interface DirectoryChildrenProps {
  projectId: string;
  worktreeId: string;
  root: FileTreeRoot;
  repoCount: number;
  parentRelativePath: string;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onActionMenu: (target: FileTreeActionTarget) => void;
  onOpenInFileManager: (absolutePath: string) => void;
}

function DirectoryChildren({
  projectId,
  worktreeId,
  root,
  repoCount,
  parentRelativePath,
  depth,
  expandedPaths,
  onToggle,
  onActionMenu,
  onOpenInFileManager,
}: DirectoryChildrenProps): JSX.Element {
  const interaction = useContext(ExplorerInteractionContext);
  const repoId = root.repoId;
  const cacheKey = getDirectoryCacheKey(
    projectId,
    worktreeId,
    repoId,
    parentRelativePath,
  );

  const { entry, error, isLoading, fetchFileTreeDirectory } = useFileListStore(
    useShallow((state) => ({
      entry: state.directoryCache[cacheKey],
      error: state.directoryErrors[cacheKey],
      isLoading: state.directoryLoading.has(cacheKey),
      fetchFileTreeDirectory: state.fetchFileTreeDirectory,
    })),
  );

  const shouldFetch = shouldFetchFilesTreeDirectory(
    projectId,
    worktreeId,
    entry,
    isLoading,
    error,
  );

  useEffect(() => {
    if (!shouldFetch) return;
    void fetchFileTreeDirectory(
      projectId,
      worktreeId,
      repoId,
      parentRelativePath,
    );
  }, [
    fetchFileTreeDirectory,
    projectId,
    worktreeId,
    repoId,
    parentRelativePath,
    shouldFetch,
  ]);

  const createEditor =
    interaction?.inlineEditor &&
    interaction.inlineEditor.mode !== 'rename' &&
    interaction.inlineEditor.node.root.repoId === repoId &&
    inlineEditorParentPath(interaction.inlineEditor) === parentRelativePath
      ? interaction.inlineEditor
      : null;

  if (error) {
    return (
      <div
        className="px-2 py-1 text-2xs"
        style={{ paddingLeft: `${depth * 16 + 32}px` }}
        data-testid="files-tree-folder-error"
      >
        <StatusLabel>Unable to load folder.</StatusLabel>
      </div>
    );
  }

  if (!entry) {
    // Expanding an uncached folder should not replace or shift the visible
    // tree with a transient loading row. The native request resolves in the
    // background and inserts children in one update. A create placeholder is
    // still rendered immediately at its final depth while that request runs.
    return createEditor ? (
      <InlineTreeEditorRow editor={createEditor} depth={depth} />
    ) : (
      <></>
    );
  }

  const entries = entry.data.entries;

  return (
    <>
      {entries.map((child) => {
        if (child.kind === 'directory') {
          const treePath = directoryTreePath(root, child.relativePath);
          const isExpanded = expandedPaths.has(treePath);
          return (
            <div key={`folder-${treePath}`}>
              <FolderRow
                label={child.name}
                depth={depth}
                expanded={isExpanded}
                isRepo={false}
                isIgnored={child.isIgnored}
                onToggle={() => onToggle(treePath)}
                copyPath={child.relativePath}
                absolutePath={child.absolutePath}
                relativePath={child.relativePath}
                root={root}
                repoCount={repoCount}
                onActionMenu={onActionMenu}
                onOpenInFileManager={onOpenInFileManager}
              />
              {isExpanded && (
                <DirectoryChildren
                  projectId={projectId}
                  worktreeId={worktreeId}
                  root={root}
                  repoCount={repoCount}
                  parentRelativePath={child.relativePath}
                  depth={depth + 1}
                  expandedPaths={expandedPaths}
                  onToggle={onToggle}
                  onActionMenu={onActionMenu}
                  onOpenInFileManager={onOpenInFileManager}
                />
              )}
            </div>
          );
        }
        return (
          <FileNodeRow
            key={`file-${repoId}::${child.relativePath}`}
            entry={child}
            root={root}
            repoCount={repoCount}
            depth={depth}
            onActionMenu={onActionMenu}
            onOpenInFileManager={onOpenInFileManager}
          />
        );
      })}
      {createEditor && (
        <InlineTreeEditorRow editor={createEditor} depth={depth} />
      )}
    </>
  );
}

interface RootRendererProps {
  projectId: string;
  worktreeId: string;
  root: FileTreeRoot;
  repoCount: number;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onActionMenu: (target: FileTreeActionTarget) => void;
  onOpenInFileManager: (absolutePath: string) => void;
}

const RootRenderer = memo(function RootRenderer({
  projectId,
  worktreeId,
  root,
  repoCount,
  depth,
  expandedPaths,
  onToggle,
  onActionMenu,
  onOpenInFileManager,
}: RootRendererProps): JSX.Element {
  const treePath = getRepoTreePath(root);
  const isExpanded = expandedPaths.has(treePath);
  return (
    <div>
      <FolderRow
        label={root.repoName}
        replayMaskLabel={isCoworkWorkspaceFileTreeRoot(root)}
        depth={depth}
        expanded={isExpanded}
        isRepo
        onToggle={() => onToggle(treePath)}
        copyPath="."
        absolutePath={root.absolutePath}
        relativePath=""
        root={root}
        repoCount={repoCount}
        onActionMenu={onActionMenu}
        onOpenInFileManager={onOpenInFileManager}
      />
      {isExpanded && (
        <DirectoryChildren
          projectId={projectId}
          worktreeId={worktreeId}
          root={root}
          repoCount={repoCount}
          parentRelativePath=""
          depth={depth + 1}
          expandedPaths={expandedPaths}
          onToggle={onToggle}
          onActionMenu={onActionMenu}
          onOpenInFileManager={onOpenInFileManager}
        />
      )}
    </div>
  );
});

interface FilteredNodesProps {
  nodes: readonly FilteredFileTreeNode[];
  root: FileTreeRoot;
  repoCount: number;
  depth: number;
  collapsedPaths: Set<string>;
  onToggle: (treePath: string) => void;
  onActionMenu: (target: FileTreeActionTarget) => void;
  onOpenInFileManager: (absolutePath: string) => void;
}

/**
 * Renders one level of a search-filtered subtree. Unlike {@link
 * DirectoryChildren} this never fetches: every node already came from the flat
 * file index, so ancestor folders of a match render whether or not the user had
 * expanded them. Folders start expanded (the point of the filter is to reveal
 * hits) and collapse into `collapsedPaths`, which the tab resets per query.
 */
function FilteredNodes({
  nodes,
  root,
  repoCount,
  depth,
  collapsedPaths,
  onToggle,
  onActionMenu,
  onOpenInFileManager,
}: FilteredNodesProps): JSX.Element {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'directory') {
          const treePath = directoryTreePath(root, node.relativePath);
          const isExpanded = !collapsedPaths.has(treePath);
          return (
            <div key={`folder-${treePath}`}>
              <FolderRow
                label={node.name}
                depth={depth}
                expanded={isExpanded}
                isRepo={false}
                onToggle={() => onToggle(treePath)}
                copyPath={node.relativePath}
                absolutePath={
                  node.absolutePath.length > 0 ? node.absolutePath : undefined
                }
                relativePath={node.relativePath}
                root={root}
                repoCount={repoCount}
                onActionMenu={onActionMenu}
                onOpenInFileManager={onOpenInFileManager}
              />
              {isExpanded && (
                <FilteredNodes
                  nodes={node.children}
                  root={root}
                  repoCount={repoCount}
                  depth={depth + 1}
                  collapsedPaths={collapsedPaths}
                  onToggle={onToggle}
                  onActionMenu={onActionMenu}
                  onOpenInFileManager={onOpenInFileManager}
                />
              )}
            </div>
          );
        }
        const entry: FileTreeEntry = {
          name: node.name,
          relativePath: node.relativePath,
          absolutePath: node.absolutePath,
          kind: 'file',
          isIgnored: node.isIgnored,
          isIndexExcluded: false,
          isSymlink: false,
          hasChildren: false,
        };
        return (
          <FileNodeRow
            key={`file-${root.repoId}::${node.relativePath}`}
            entry={entry}
            root={root}
            repoCount={repoCount}
            depth={depth}
            onActionMenu={onActionMenu}
            onOpenInFileManager={onOpenInFileManager}
          />
        );
      })}
    </>
  );
}

interface FilesTreeTabProps {
  projectId: string | null;
  worktreeId: string | null;
  /** Separates expansion and scroll state from other trees in the worktree. */
  uiStateScope?: string;
  /**
   * Whether this surface should respond to the Cmd/Ctrl+F search shortcut.
   * The keydown listener is attached to the owning document, so the hosting
   * panel passes its `isActive` bit and only the focused panel opens its search
   * input. Defaults to `true` for single-instance hosts.
   */
  searchShortcutActive?: boolean;
  /** Native filesystem watching is armed only while this panel is visible. */
  isVisible?: boolean;
  /**
   * Host override for opening a file (row click and the context menu's
   * plain "Open"). Embedded per-file-tab trees pass this so a selection
   * lands in their own tab; "Open to the Side" keeps the global behavior.
   */
  onOpenFile?: (file: { absolutePath: string; filename: string }) => void;
  /** Absolute path of the file shown beside this embedded tree. */
  currentFilePath?: string;
  /** Absolute path of a directory an empty file tab should reveal. */
  initialDirectoryPath?: string;
  /** Reveal and expand `initialDirectoryPath` once. */
  revealInitialDirectory?: boolean;
  /** Records that the one-shot directory reveal ran. */
  onInitialDirectoryReveal?: (directoryPath: string) => void;
  /** Reveal `currentFilePath` once before yielding expansion state to the user. */
  revealCurrentFileInitially?: boolean;
  /** Records that the one-shot reveal ran for this tab/file identity. */
  onCurrentFileInitialReveal?: (filePath: string) => void;
  /** Embedded file panel toolbar; standalone Explorer retains its existing chrome. */
  onTreeModeChange?: (mode: 'file' | 'diff') => void;
}

interface FileTreeSearchUiStateReporterProps {
  projectId: string;
  worktreeId: string;
  open: boolean;
  filtering: boolean;
}

function FileTreeSearchUiStateReporter({
  projectId,
  worktreeId,
  open,
  filtering,
}: FileTreeSearchUiStateReporterProps): JSX.Element {
  useCurrentUiStateReporter('files.treeSearch', {
    projectId,
    worktreeId,
    open,
    filtering,
  });
  return <></>;
}

export function FilesTreeTab({
  projectId,
  worktreeId,
  uiStateScope,
  searchShortcutActive = true,
  isVisible = true,
  onOpenFile,
  currentFilePath,
  initialDirectoryPath,
  revealInitialDirectory = false,
  onInitialDirectoryReveal,
  revealCurrentFileInitially = false,
  onCurrentFileInitialReveal,
  onTreeModeChange,
}: FilesTreeTabProps): JSX.Element {
  const panelHostVisible = usePanelHostState().visible !== false;
  const effectiveVisible = isVisible && panelHostVisible;
  // Read-only scopes (a shared-container recipient) browse and open files but
  // never rename, delete, move, paste, or open the mutate context menu.
  const readOnly = useWorkspaceIsReadOnly();
  const startPageEnabled = useCanopyDesktopStartPageEnabled();
  const projectType = useProjectsStore(
    (state) => state.projects.find((project) => project.id === projectId)?.type,
  );
  const resolvedStartPage = useStartPageStore((state) =>
    projectId && worktreeId
      ? state.resolved[`${projectId}:${worktreeId}`]
      : undefined,
  );
  useEffect(() => {
    if (startPageEnabled && projectType && projectId && worktreeId) {
      void useStartPageStore.getState().refresh(projectId, worktreeId);
    }
  }, [projectId, projectType, startPageEnabled, worktreeId]);
  const [actionTarget, setActionTarget] = useState<FileTreeActionTarget | null>(
    null,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(
    null,
  );
  const [clipboard, setClipboard] = useState<{
    operation: 'copy' | 'cut';
    nodes: ExplorerNode[];
  } | null>(null);
  const [inlineEditor, setInlineEditor] = useState<InlineEditorState | null>(
    null,
  );
  const [deleteTargets, setDeleteTargets] = useState<ExplorerNode[]>([]);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const nodesRef = useRef(new Map<string, ExplorerNode>());
  const standaloneFileOpenedRef = useRef(false);
  const dragNodesRef = useRef<ExplorerNode[]>([]);
  const dragExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragExpandTargetIdRef = useRef<string | null>(null);
  const refreshVisibleDirectoriesRef = useRef<(() => Promise<void>) | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // Folders the user collapsed inside the current result set. Filtered folders
  // default to expanded, so this tracks the exceptions and resets per query.
  const [collapsedSearchPaths, setCollapsedSearchPaths] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingCurrentFileScrollCleanupRef = useRef<(() => void) | null>(null);
  const initialRevealStartedRef = useRef<string | null>(null);
  const initialDirectoryRevealStartedRef = useRef<string | null>(null);
  // Whether a filter is currently narrowing the tree. Read by scroll listeners
  // that outlive a render, so it has to be a ref rather than the render value.
  const searchActiveRef = useRef(false);
  const previousSearchActiveRef = useRef(false);
  // Tracks whether the saved scroll offset has been restored for the current
  // worktree, so restoration runs once per worktree and does not fight the user.
  const scrollRestoredRef = useRef(false);
  // The worktree the restore flag currently applies to; used to re-arm
  // restoration when the worktree changes (checked inside the layout effect so
  // it happens before restore, unlike a separate effect which would run after).
  const scrollCacheKeyRef = useRef<string | null>(null);
  const cacheKey =
    projectId && worktreeId ? getWorktreeCacheKey(projectId, worktreeId) : null;
  const uiStateKey =
    projectId && worktreeId
      ? getFileTreeUiStateKey(projectId, worktreeId, uiStateScope)
      : null;
  const indexCacheKey =
    projectId && worktreeId
      ? getFileTreeIndexCacheKey(projectId, worktreeId)
      : null;

  const {
    rootsEntry,
    rootsError,
    rootsLoading,
    indexEntry,
    indexError,
    indexLoading,
    fetchFileTreeIndex,
    fetchFileTreeRoots,
    fetchFileTreeDirectory,
    markFileTreeStale,
    expandedPaths,
    hasExpansionState,
    setFileTreeExpandedPaths,
    toggleFileTreeExpandedPath,
    setFileTreeScrollPosition,
  } = useFileListStore(
    useShallow((state) => ({
      rootsEntry: cacheKey ? state.rootsCache[cacheKey] : undefined,
      rootsError: cacheKey ? state.rootsErrors[cacheKey] : undefined,
      rootsLoading: cacheKey ? state.rootsLoading.has(cacheKey) : false,
      indexEntry: indexCacheKey ? state.indexCache[indexCacheKey] : undefined,
      indexError: indexCacheKey ? state.indexErrors[indexCacheKey] : undefined,
      indexLoading: indexCacheKey
        ? state.indexLoading.has(indexCacheKey)
        : false,
      fetchFileTreeIndex: state.fetchFileTreeIndex,
      fetchFileTreeRoots: state.fetchFileTreeRoots,
      fetchFileTreeDirectory: state.fetchFileTreeDirectory,
      markFileTreeStale: state.markFileTreeStale,
      expandedPaths: uiStateKey
        ? (state.fileTreeExpandedPaths[uiStateKey] ?? EMPTY_EXPANDED_PATHS)
        : EMPTY_EXPANDED_PATHS,
      hasExpansionState: uiStateKey
        ? Object.prototype.hasOwnProperty.call(
            state.fileTreeExpandedPaths,
            uiStateKey,
          )
        : false,
      setFileTreeExpandedPaths: state.setFileTreeExpandedPaths,
      toggleFileTreeExpandedPath: state.toggleFileTreeExpandedPath,
      setFileTreeScrollPosition: state.setFileTreeScrollPosition,
    })),
  );

  // Keep the last roots for this exact worktree mounted while an external
  // invalidation refetches them. Unmounting the tree during that short window
  // causes both a visible loading flash and loss of the selected folder used
  // by toolbar create actions.
  const retainedRootsEntryRef = useRef<{
    cacheKey: string;
    entry: NonNullable<typeof rootsEntry>;
  } | null>(null);
  if (cacheKey && rootsEntry) {
    retainedRootsEntryRef.current = { cacheKey, entry: rootsEntry };
  }
  const renderedRootsEntry =
    rootsEntry ??
    (rootsLoading &&
    !rootsError &&
    retainedRootsEntryRef.current?.cacheKey === cacheKey
      ? retainedRootsEntryRef.current.entry
      : undefined);

  const cancelPendingCurrentFileScroll = useCallback((): void => {
    pendingCurrentFileScrollCleanupRef.current?.();
    pendingCurrentFileScrollCleanupRef.current = null;
  }, []);

  const handleCapturedUserScrollIntent = useCallback((): void => {
    cancelPendingCurrentFileScroll();
    scrollRestoredRef.current = true;
  }, [cancelPendingCurrentFileScroll]);

  const handleCapturedScroll = useCallback(
    (event: UIEvent<HTMLDivElement>): void => {
      setActionTarget(null);
      const scrollTop = event.currentTarget.scrollTop;
      if (
        !projectId ||
        !worktreeId ||
        !scrollRestoredRef.current ||
        // A filtered tree is a transient view of a different row set; its
        // offset must not overwrite the saved position of the real tree.
        searchActiveRef.current ||
        scrollTop <= 0
      ) {
        return;
      }
      // This React-owned listener remains attached while the layout effect is
      // replaced for tree-data changes. It is the stable fallback for a
      // positive user offset observed during that replacement window.
      setFileTreeScrollPosition(projectId, worktreeId, scrollTop, uiStateScope);
    },
    [projectId, setFileTreeScrollPosition, uiStateScope, worktreeId],
  );

  const shouldFetch = shouldFetchFilesTreeRoots(
    projectId,
    worktreeId,
    rootsEntry,
    rootsLoading,
    rootsError,
  );

  useEffect(() => {
    if (!projectId || !worktreeId) return;
    if (!shouldFetch) return;
    void fetchFileTreeRoots(projectId, worktreeId);
  }, [projectId, worktreeId, shouldFetch, fetchFileTreeRoots]);

  const roots = useMemo<FileTreeRoot[]>(
    () => renderedRootsEntry?.data.roots ?? [],
    [renderedRootsEntry],
  );
  // The catalog stays flat; only its presentation groups app-owned roots.
  const rootGroups = useMemo(() => partitionFileTreeRoots(roots), [roots]);
  const groupedRootTreePaths = useMemo(
    () => new Set(rootGroups.appManaged.map(getRepoTreePath)),
    [rootGroups],
  );
  const currentFileTarget = useMemo(
    () => resolveFileTreeTarget(currentFilePath, roots, 'file'),
    [currentFilePath, roots],
  );
  const initialDirectoryTarget = useMemo(
    () => resolveFileTreeTarget(initialDirectoryPath, roots, 'directory'),
    [initialDirectoryPath, roots],
  );

  const startCurrentFileScroll = useCallback(
    (nodeId: string): void => {
      cancelPendingCurrentFileScroll();
      const container = scrollRef.current;
      if (!container) return;
      const ownerWindow = container.ownerDocument.defaultView ?? window;
      let observer: MutationObserver | null = null;
      let frame = 0;
      let timeout = 0;
      let finished = false;

      const cleanup = (): void => {
        if (finished) return;
        finished = true;
        observer?.disconnect();
        if (frame) ownerWindow.cancelAnimationFrame(frame);
        if (timeout) ownerWindow.clearTimeout(timeout);
        if (pendingCurrentFileScrollCleanupRef.current === cleanup) {
          pendingCurrentFileScrollCleanupRef.current = null;
        }
      };
      const revealIfReady = (): boolean => {
        const target = hostRef.current?.querySelector<HTMLElement>(
          `[data-file-tree-id="${nodeId}"]`,
        );
        if (!target) return false;
        if (!isFullyVisibleInScrollContainer(target, container)) {
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        cleanup();
        return true;
      };

      pendingCurrentFileScrollCleanupRef.current = cleanup;
      if (revealIfReady()) return;
      observer = new MutationObserver(() => revealIfReady());
      observer.observe(container, { childList: true, subtree: true });
      frame = ownerWindow.requestAnimationFrame(() => revealIfReady());
      timeout = ownerWindow.setTimeout(cleanup, 10_000);
    },
    [cancelPendingCurrentFileScroll],
  );

  const revealTarget = useCallback(
    (target: CurrentFileTreeTarget): boolean => {
      if (!projectId || !worktreeId || !uiStateKey) {
        return false;
      }
      const liveExpandedPaths =
        useFileListStore.getState().fileTreeExpandedPaths[uiStateKey] ??
        EMPTY_EXPANDED_PATHS;
      const expansionNeeded = Array.from(target.expandedPaths).some(
        (path) => !liveExpandedPaths.has(path),
      );
      const container = scrollRef.current;
      const mountedTarget = hostRef.current?.querySelector<HTMLElement>(
        `[data-file-tree-id="${target.nodeId}"]`,
      );
      if (
        !expansionNeeded &&
        container &&
        mountedTarget &&
        isFullyVisibleInScrollContainer(mountedTarget, container)
      ) {
        return false;
      }

      if (searchActiveRef.current) {
        setSearchQuery('');
        setSearchOpen(false);
      }
      const nextExpandedPaths = new Set(liveExpandedPaths);
      let expansionChanged = false;
      target.expandedPaths.forEach((path) => {
        if (!nextExpandedPaths.has(path)) {
          nextExpandedPaths.add(path);
          expansionChanged = true;
        }
      });
      if (expansionChanged) {
        setFileTreeExpandedPaths(
          projectId,
          worktreeId,
          nextExpandedPaths,
          uiStateScope,
        );
      }
      scrollRestoredRef.current = true;
      startCurrentFileScroll(target.nodeId);
      return true;
    },
    [
      projectId,
      setFileTreeExpandedPaths,
      startCurrentFileScroll,
      uiStateKey,
      uiStateScope,
      worktreeId,
    ],
  );

  const revealCurrentFile = useCallback(
    (): boolean =>
      currentFileTarget ? revealTarget(currentFileTarget) : false,
    [currentFileTarget, revealTarget],
  );

  useEffect((): (() => void) => {
    return (): void => {
      cancelPendingCurrentFileScroll();
    };
  }, [cancelPendingCurrentFileScroll]);

  useEffect(() => {
    if (focusedId || roots.length === 0) return;
    const firstId = explorerNodeId(roots[0], '');
    setFocusedId(firstId);
    setSelectionAnchorId(firstId);
  }, [focusedId, roots]);

  useEffect(() => {
    if (!projectId || !worktreeId || hasExpansionState) return;
    if (!renderedRootsEntry) return;
    const repoPathToExpand = getAutoExpandRepoPath(
      renderedRootsEntry.data.roots,
      false,
    );
    setFileTreeExpandedPaths(
      projectId,
      worktreeId,
      repoPathToExpand ? new Set([repoPathToExpand]) : new Set(),
      uiStateScope,
    );
  }, [
    projectId,
    worktreeId,
    renderedRootsEntry,
    hasExpansionState,
    setFileTreeExpandedPaths,
    uiStateScope,
  ]);

  useEffect(() => {
    if (
      !revealInitialDirectory ||
      !initialDirectoryPath ||
      !initialDirectoryTarget ||
      initialDirectoryRevealStartedRef.current === initialDirectoryPath
    ) {
      return;
    }
    initialDirectoryRevealStartedRef.current = initialDirectoryPath;
    revealTarget(initialDirectoryTarget);
    onInitialDirectoryReveal?.(initialDirectoryPath);
  }, [
    initialDirectoryPath,
    initialDirectoryTarget,
    onInitialDirectoryReveal,
    revealInitialDirectory,
    revealTarget,
  ]);

  useEffect(() => {
    if (
      !revealCurrentFileInitially ||
      !currentFilePath ||
      !currentFileTarget ||
      initialRevealStartedRef.current === currentFilePath
    ) {
      return;
    }
    initialRevealStartedRef.current = currentFilePath;
    revealCurrentFile();
    onCurrentFileInitialReveal?.(currentFilePath);
  }, [
    currentFilePath,
    currentFileTarget,
    onCurrentFileInitialReveal,
    revealCurrentFile,
    revealCurrentFileInitially,
  ]);

  // Debounce the raw input so a burst of keystrokes rebuilds the filtered tree
  // once. Clearing the box takes effect immediately — there is nothing to
  // recompute, and the unfiltered tree should come straight back.
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (trimmed.length === 0) {
      setDebouncedQuery('');
      return;
    }
    const timer = window.setTimeout((): void => {
      setDebouncedQuery(trimmed);
    }, FILE_TREE_SEARCH_DEBOUNCE_MS);
    return (): void => window.clearTimeout(timer);
  }, [searchQuery]);

  const normalizedQuery = normalizeFileTreeSearchQuery(debouncedQuery);
  const searchActive = searchOpen && normalizedQuery.length > 0;
  searchActiveRef.current = searchActive;
  useRetainFileIndex(effectiveVisible && searchActive ? indexCacheKey : null);

  // A new query means a new result set, so per-result collapse state starts
  // over. Skipped when nothing was collapsed, to avoid a pointless re-render.
  useEffect(() => {
    setCollapsedSearchPaths((current) =>
      current.size === 0 ? current : new Set<string>(),
    );
  }, [normalizedQuery]);

  // The explorer-specific flat index is only pulled once the user actually
  // searches. It includes paths excluded from Cmd+P/@ mentions because those
  // paths remain visible in the explorer.
  useEffect(() => {
    if (!effectiveVisible || !searchActive || !projectId || !worktreeId) {
      return;
    }
    if (
      !shouldFetchFilesTreeIndex(
        projectId,
        worktreeId,
        indexEntry,
        indexLoading,
        indexError,
      )
    ) {
      return;
    }
    void fetchFileTreeIndex(projectId, worktreeId);
  }, [
    effectiveVisible,
    searchActive,
    projectId,
    worktreeId,
    indexEntry,
    indexLoading,
    indexError,
    fetchFileTreeIndex,
  ]);

  useEffect(() => {
    if (!searchShortcutActive || !projectId || !worktreeId) return;
    const handleSetSearch = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      if (!isFileTreeSetSearchDetail(event.detail)) return;
      if (
        event.detail.projectId !== projectId ||
        event.detail.worktreeId !== worktreeId
      ) {
        return;
      }
      event.detail.acknowledge();
      setSearchQuery(event.detail.query);
      setSearchOpen(event.detail.query.trim().length > 0);
    };
    window.addEventListener(FILE_TREE_SET_SEARCH_EVENT, handleSetSearch);
    return (): void =>
      window.removeEventListener(FILE_TREE_SET_SEARCH_EVENT, handleSetSearch);
  }, [projectId, searchShortcutActive, worktreeId]);

  // Cmd/Ctrl+F opens the search input and focuses it; a repeat press re-focuses
  // and selects the existing query. Gated on `searchShortcutActive` and the
  // owning document's focus state so split panels and popped-out windows do not
  // all react to one keypress (same contract as ChatContent's search tray).
  useEffect(() => {
    if (!searchShortcutActive) return;
    const shortcutDocument = hostRef.current?.ownerDocument ?? document;
    function handleKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== 'f') return;
      if (!shortcutDocument.hasFocus()) return;
      event.preventDefault();
      if (searchOpen) {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else {
        setSearchOpen(true);
      }
    }
    shortcutDocument.addEventListener('keydown', handleKeyDown);
    return (): void =>
      shortcutDocument.removeEventListener('keydown', handleKeyDown);
  }, [searchOpen, searchShortcutActive]);

  // Focus on open. The input mounts with the tray, so this runs after the DOM
  // node exists regardless of whether the shortcut or the toolbar button
  // opened it.
  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchOpen]);

  const filteredResults = useMemo((): {
    entries: { root: FileTreeRoot; nodes: readonly FilteredFileTreeNode[] }[];
    matchCount: number;
    shownCount: number;
  } => {
    if (!searchActive) {
      return { entries: [], matchCount: 0, shownCount: 0 };
    }
    const repos = indexEntry?.data.repos ?? [];
    const filesByRepoId = new Map(
      repos.map((repo) => [repo.repoId, repo.files]),
    );
    let remaining = FILE_TREE_SEARCH_RESULT_LIMIT;
    let matchCount = 0;
    let shownCount = 0;
    const entries: {
      root: FileTreeRoot;
      nodes: readonly FilteredFileTreeNode[];
    }[] = [];
    for (const root of roots) {
      const tree = buildFilteredFileTree(
        filesByRepoId.get(root.repoId) ?? [],
        normalizedQuery,
        remaining,
      );
      matchCount += tree.matchCount;
      shownCount += tree.shownCount;
      remaining -= tree.shownCount;
      if (tree.nodes.length > 0) {
        entries.push({ root, nodes: tree.nodes });
      }
    }
    return { entries, matchCount, shownCount };
  }, [searchActive, indexEntry, roots, normalizedQuery]);

  // VS Code-style sticky scroll: folder headers are `position: sticky` and stack
  // at the top of the scroll container as you scroll into their subtree (see
  // FileTreeRow's sticky styling). Here we (a) measure a real row height so the
  // per-depth sticky offsets line up exactly, (b) flag which folder headers are
  // actually pinned so only the current parent stack shows the drop shadow, and
  // (c) persist/restore the scroll offset per worktree so navigating away,
  // collapsing the panel, or switching worktrees returns to the same place.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const searchJustClosed = previousSearchActiveRef.current && !searchActive;
    previousSearchActiveRef.current = searchActive;
    if (searchJustClosed) {
      scrollRestoredRef.current = false;
    }

    // Re-arm restoration (a) when the worktree changes, so the newly selected
    // one restores its own saved offset, and (b) when content is gone — e.g. a
    // refresh swapped the tree for a loading placeholder — so the saved offset
    // is reapplied once it repopulates.
    if (scrollCacheKeyRef.current !== uiStateKey) {
      scrollCacheKeyRef.current = uiStateKey;
      scrollRestoredRef.current = false;
    }
    if (roots.length === 0) {
      scrollRestoredRef.current = false;
    }

    let frame = 0;
    let restoreFrame = 0;
    let intentPersistFrame = 0;
    let persistTimer: number | null = null;
    let pendingScrollTop: number | null = null;
    let userScrollIntent = false;
    let allowNextZeroPersist = false;
    let directManipulationActive = false;
    let lastObservedScrollTop = container.scrollTop;
    let rowHeight = 28;
    let rootHeight = 28;

    const hasFolderRows = (): boolean =>
      container.querySelector('[data-file-tree-folder]') !== null;

    const clearPersistTimer = (): void => {
      if (persistTimer !== null) {
        window.clearTimeout(persistTimer);
        persistTimer = null;
      }
      pendingScrollTop = null;
    };

    const persistScrollPosition = (): void => {
      persistTimer = null;
      const scrollTop = pendingScrollTop;
      pendingScrollTop = null;
      if (
        projectId &&
        worktreeId &&
        scrollRestoredRef.current &&
        !searchActive &&
        hasFolderRows() &&
        scrollTop !== null
      ) {
        setFileTreeScrollPosition(
          projectId,
          worktreeId,
          scrollTop,
          uiStateScope,
        );
      }
    };

    const schedulePersist = (allowZero: boolean): void => {
      if (
        !scrollRestoredRef.current ||
        !hasFolderRows() ||
        container.scrollHeight <= container.clientHeight ||
        (container.scrollTop === 0 && !allowZero)
      ) {
        return;
      }
      clearPersistTimer();
      // Capture the meaningful offset now. Hiding or closing the panel can
      // clamp the live scrollTop to zero before this debounce fires.
      pendingScrollTop = container.scrollTop;
      persistTimer = window.setTimeout(persistScrollPosition, 150);
    };

    const flushPersistTimer = (): void => {
      if (persistTimer === null) return;
      const timer = persistTimer;
      persistScrollPosition();
      window.clearTimeout(timer);
    };

    const measureRowHeight = (): void => {
      // Nested folders (depth > 0) all share identical markup, so one of them is
      // the exact per-level offset unit. The repo-root row (depth 0) is a
      // slightly different height, so measure it separately — otherwise the
      // first child would pin one nested-row-height down and leave a gap under
      // the (shorter) root.
      const nested = container.querySelector<HTMLElement>(
        '[data-file-tree-folder]:not([data-sticky-depth="0"])',
      );
      if (nested) {
        const height = nested.getBoundingClientRect().height;
        if (height > 0) {
          rowHeight = height;
          container.style.setProperty('--file-tree-row-height', `${height}px`);
        }
      }
      const root = container.querySelector<HTMLElement>(
        '[data-file-tree-folder][data-sticky-depth="0"]',
      );
      if (root) {
        const height = root.getBoundingClientRect().height;
        if (height > 0) {
          rootHeight = height;
          container.style.setProperty('--file-tree-root-height', `${height}px`);
        }
      }
    };

    // Resting sticky offset for a header at `depth`: the root pins at 0, and
    // each nested header pins below the root plus one row per intervening level.
    const expectedTop = (depth: number): number =>
      depth <= 0 ? 0 : rootHeight + (depth - 1) * rowHeight;

    const updateStuck = (): void => {
      frame = 0;
      const scrolled = container.scrollTop > 0;
      if (
        container.scrollTop !== lastObservedScrollTop &&
        container.scrollTop > 0 &&
        scrollRestoredRef.current
      ) {
        // Passive compositor scrolling can become visible before Chromium
        // delivers the corresponding DOM scroll event. Any layout/sticky
        // observation of a new positive offset is therefore also a safe
        // opportunity to queue the in-memory remount snapshot.
        schedulePersist(false);
      }
      lastObservedScrollTop = container.scrollTop;
      const containerTop = container.getBoundingClientRect().top;
      const folders = container.querySelectorAll<HTMLElement>(
        '[data-file-tree-folder]',
      );
      let edge: HTMLElement | null = null;
      let edgeDepth = -1;
      folders.forEach((folder) => {
        const depth = Number(folder.dataset.stickyDepth ?? '0');
        const offset = folder.getBoundingClientRect().top - containerTop;
        // A header is pinned only while it rests exactly at its sticky line.
        // Rows still scrolling toward it, or being pushed back out as their
        // section ends, sit off the line and stay unpinned so they don't float
        // over the pinned ancestor stack. The deepest pinned row (max depth) is
        // the block's bottom edge and carries the radius + border + shadow.
        const stuck = scrolled && Math.abs(offset - expectedTop(depth)) <= 1;
        const next = stuck ? 'true' : 'false';
        if (folder.dataset.stuck !== next) {
          folder.dataset.stuck = next;
        }
        if (stuck && depth > edgeDepth) {
          edgeDepth = depth;
          edge = folder;
        }
      });
      folders.forEach((folder) => {
        const next = folder === edge ? 'true' : 'false';
        if (folder.dataset.stuckEdge !== next) {
          folder.dataset.stuckEdge = next;
        }
      });
    };

    // Restore the saved offset. The tree loads lazily, so scrollHeight may still
    // be growing on mount; retry across a few frames until the container is tall
    // enough to reach the saved offset. If it is still too short after the
    // frame budget, leave restoration pending so later DOM growth can retry
    // without persisting the temporary clamped offset.
    const restoreScroll = (): void => {
      if (scrollRestoredRef.current || !uiStateKey) return;
      // Filtered rows are not the saved tree, so restoration waits for the
      // query to clear rather than landing on an unrelated offset.
      if (searchActiveRef.current) return;
      if (!hasFolderRows()) return;
      const saved =
        useFileListStore.getState().fileTreeScrollPositions[uiStateKey];
      if (saved === undefined || saved <= 0) {
        container.scrollTop = 0;
        scrollRestoredRef.current = true;
        return;
      }
      let attempts = 0;
      const tryRestore = (): void => {
        restoreFrame = 0;
        if (scrollRestoredRef.current) return;
        const maxScroll = container.scrollHeight - container.clientHeight;
        container.scrollTop = Math.min(saved, Math.max(0, maxScroll));
        if (container.scrollTop >= saved - 1) {
          scrollRestoredRef.current = true;
          updateStuck();
          return;
        }
        attempts += 1;
        if (attempts >= 20) return;
        restoreFrame = requestAnimationFrame(tryRestore);
      };
      tryRestore();
    };

    const schedule = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(updateStuck);
    };

    const handleDiscreteScrollIntent = (): void => {
      userScrollIntent = true;
      allowNextZeroPersist = true;
      if (intentPersistFrame) {
        cancelAnimationFrame(intentPersistFrame);
      }
      // Chromium can apply compositor-driven wheel scrolling without
      // delivering a usable DOM `scroll` event before this panel changes
      // ownership. Read the post-default-action offset on the next frame so
      // direct wheel/keyboard input still reaches the remount durability
      // boundary.
      intentPersistFrame = requestAnimationFrame(() => {
        intentPersistFrame = 0;
        scrollRestoredRef.current = true;
        schedulePersist(true);
        schedule();
      });
    };

    const handleDirectManipulationStart = (): void => {
      userScrollIntent = true;
      directManipulationActive = true;
    };

    const handleDirectManipulationEnd = (): void => {
      directManipulationActive = false;
    };

    const handleScroll = (): void => {
      if (!scrollRestoredRef.current && userScrollIntent) {
        scrollRestoredRef.current = true;
      }
      schedule();
      schedulePersist(directManipulationActive || allowNextZeroPersist);
      allowNextZeroPersist = false;
    };

    measureRowHeight();
    restoreScroll();
    updateStuck();

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleDiscreteScrollIntent, {
      passive: true,
    });
    container.addEventListener('touchstart', handleDirectManipulationStart, {
      passive: true,
    });
    container.addEventListener('pointerdown', handleDirectManipulationStart);
    container.addEventListener('keydown', handleDiscreteScrollIntent);
    window.addEventListener('touchend', handleDirectManipulationEnd);
    window.addEventListener('touchcancel', handleDirectManipulationEnd);
    window.addEventListener('pointerup', handleDirectManipulationEnd);
    window.addEventListener('pointercancel', handleDirectManipulationEnd);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            measureRowHeight();
            schedule();
            restoreScroll();
          })
        : null;
    resizeObserver?.observe(container);
    const mutationObserver =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            measureRowHeight();
            schedule();
            restoreScroll();
          })
        : null;
    mutationObserver?.observe(container, { childList: true, subtree: true });

    return (): void => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleDiscreteScrollIntent);
      container.removeEventListener(
        'touchstart',
        handleDirectManipulationStart,
      );
      container.removeEventListener(
        'pointerdown',
        handleDirectManipulationStart,
      );
      container.removeEventListener('keydown', handleDiscreteScrollIntent);
      window.removeEventListener('touchend', handleDirectManipulationEnd);
      window.removeEventListener('touchcancel', handleDirectManipulationEnd);
      window.removeEventListener('pointerup', handleDirectManipulationEnd);
      window.removeEventListener('pointercancel', handleDirectManipulationEnd);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (restoreFrame) cancelAnimationFrame(restoreFrame);
      if (intentPersistFrame) {
        cancelAnimationFrame(intentPersistFrame);
        intentPersistFrame = 0;
        scrollRestoredRef.current = true;
        schedulePersist(true);
      }
      flushPersistTimer();
    };
  }, [
    roots,
    expandedPaths,
    uiStateKey,
    projectId,
    worktreeId,
    setFileTreeScrollPosition,
    searchActive,
    uiStateScope,
  ]);
  const indexTruncated =
    indexEntry?.data.repos.some((repo) => repo.truncated === true) ?? false;

  const handleTogglePath = useCallback(
    (path: string): void => {
      if (!projectId || !worktreeId) return;
      cancelPendingCurrentFileScroll();
      setActionTarget(null);
      toggleFileTreeExpandedPath(projectId, worktreeId, path, uiStateScope);
    },
    [
      cancelPendingCurrentFileScroll,
      projectId,
      uiStateScope,
      worktreeId,
      toggleFileTreeExpandedPath,
    ],
  );

  const handleToggleFilteredPath = useCallback(
    (path: string): void => {
      cancelPendingCurrentFileScroll();
      setActionTarget(null);
      setCollapsedSearchPaths((current) => {
        const next = new Set(current);
        if (!next.delete(path)) {
          next.add(path);
        }
        return next;
      });
    },
    [cancelPendingCurrentFileScroll],
  );

  const handleToggleSearch = useCallback((): void => {
    setActionTarget(null);
    setSearchOpen((open) => {
      if (open) {
        // Closing drops the filter so the full tree comes back.
        setSearchQuery('');
        return false;
      }
      return true;
    });
    // Re-focus when the tray was already open but the input had lost focus.
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  const handleCloseSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchQuery('');
  }, []);

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        handleCloseSearch();
      }
    },
    [handleCloseSearch],
  );

  const handleOpenActionMenu = useCallback(
    (target: FileTreeActionTarget): void => {
      setActionTarget(target);
    },
    [],
  );

  const handleCloseActionMenu = useCallback((): void => {
    setActionTarget(null);
  }, []);
  const handleOpenInFileManager = useCallback(
    (absolutePath: string): void => {
      if (!projectId || !worktreeId) return;
      void window.api.showInFinder({
        absolutePath,
        projectId,
        worktreeId,
      });
    },
    [projectId, worktreeId],
  );

  const handleRefresh = useCallback((): void => {
    if (!projectId || !worktreeId) return;
    if (rootsLoading) return;
    setActionTarget(null);
    // Keep the current tree mounted while refreshed data is fetched. Clearing
    // these caches here replaced the entire panel with LoadingPlaceholder and
    // made every filesystem mutation visibly flash.
    markFileTreeStale(projectId, worktreeId);
    void fetchFileTreeRoots(projectId, worktreeId);
    if (searchActive && effectiveVisible) {
      void fetchFileTreeIndex(projectId, worktreeId);
    }
    // Re-fetch every visible directory so already-expanded folders refresh
    // in place after the user clicks Refresh.
    if (searchActive) return;
    expandedPaths.forEach((treePath) => {
      if (
        !isVisibleExpandedTreePath(
          treePath,
          expandedPaths,
          groupedRootTreePaths,
        )
      )
        return;
      const repoMatch = /^repo:([^/]+)(?:\/(.*))?$/.exec(treePath);
      if (!repoMatch) return;
      const [, repoId, relativePath] = repoMatch;
      void fetchFileTreeDirectory(
        projectId,
        worktreeId,
        repoId,
        relativePath ?? '',
      );
    });
  }, [
    projectId,
    worktreeId,
    rootsLoading,
    markFileTreeStale,
    searchActive,
    effectiveVisible,
    fetchFileTreeIndex,
    fetchFileTreeRoots,
    fetchFileTreeDirectory,
    expandedPaths,
    groupedRootTreePaths,
  ]);

  const refreshVisibleDirectories = useCallback(async (): Promise<void> => {
    if (!projectId || !worktreeId) return;
    markFileTreeStale(projectId, worktreeId);
    const requests: Promise<void>[] = [
      fetchFileTreeRoots(projectId, worktreeId),
    ];
    if (searchActive && effectiveVisible) {
      requests.push(fetchFileTreeIndex(projectId, worktreeId));
    }
    if (!searchActive) {
      expandedPaths.forEach((treePath) => {
        if (
          !isVisibleExpandedTreePath(
            treePath,
            expandedPaths,
            groupedRootTreePaths,
          )
        )
          return;
        const repoMatch = /^repo:([^/]+)(?:\/(.*))?$/.exec(treePath);
        if (!repoMatch) return;
        requests.push(
          fetchFileTreeDirectory(
            projectId,
            worktreeId,
            repoMatch[1],
            repoMatch[2] ?? '',
          ),
        );
      });
    }
    await Promise.all(requests);
  }, [
    expandedPaths,
    groupedRootTreePaths,
    fetchFileTreeDirectory,
    fetchFileTreeIndex,
    fetchFileTreeRoots,
    markFileTreeStale,
    projectId,
    searchActive,
    effectiveVisible,
    worktreeId,
  ]);
  refreshVisibleDirectoriesRef.current = refreshVisibleDirectories;

  useEffect(() => {
    if (!isVisible || !projectId || !worktreeId) {
      setWatching(false);
      return;
    }
    // Older embedded renderers and focused unit fixtures may expose the read
    // API without the optional watcher bridge. The explorer remains fully
    // usable via refresh in that compatibility mode.
    if (
      typeof window.api.onFileTreeChanged !== 'function' ||
      typeof window.api.startFileTreeWatch !== 'function' ||
      typeof window.api.stopFileTreeWatch !== 'function'
    ) {
      setWatching(false);
      return;
    }
    let disposed = false;
    const unsubscribe = window.api.onFileTreeChanged((event) => {
      if (event.projectId === projectId && event.worktreeId === worktreeId) {
        void refreshVisibleDirectoriesRef.current?.();
      }
    });
    // Refcounted shared watch: multiple mounted explorer surfaces for the
    // same worktree (standalone panel + embedded per-file-tab trees) share
    // one main-side native watch, released with the last consumer.
    void acquireFileTreeWatch(projectId, worktreeId)
      .then(async () => {
        if (!disposed) {
          // Reconcile changes that may have landed while this panel was hidden
          // or before its first native watcher was attached.
          await refreshVisibleDirectoriesRef.current?.();
          if (!disposed) setWatching(true);
        }
      })
      .catch(() => {
        if (!disposed) setWatching(false);
      });
    return (): void => {
      disposed = true;
      setWatching(false);
      unsubscribe();
      releaseFileTreeWatch(projectId, worktreeId);
    };
  }, [isVisible, projectId, worktreeId]);

  const visibleRowIds = useCallback((): string[] => {
    const host = hostRef.current;
    if (!host) return [];
    return Array.from(
      host.querySelectorAll<HTMLElement>('[data-file-tree-id]'),
      (element) => element.dataset.fileTreeId ?? '',
    ).filter(Boolean);
  }, []);

  const noteFileOpened = useCallback((): void => {
    if (onOpenFile) {
      // Embedded trees reserve their persistent row treatment for the file
      // actually owned by the panel.
      setSelectedIds(new Set());
      setSelectionAnchorId(null);
      return;
    }
    // A standalone tree keeps ordinary selection available for multi-select
    // gestures until navigation hides it, then drops the opened-file marker.
    standaloneFileOpenedRef.current = true;
  }, [onOpenFile]);

  const openFile = useCallback(
    (file: { absolutePath: string; filename: string }): void => {
      if (onOpenFile) {
        onOpenFile(file);
        return;
      }
      if (!projectId || !worktreeId) return;
      useChatStore.getState().openFileTab(file, { projectId, worktreeId });
    },
    [onOpenFile, projectId, worktreeId],
  );

  useEffect(() => {
    if (isVisible || !standaloneFileOpenedRef.current) return;
    standaloneFileOpenedRef.current = false;
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  }, [isVisible]);

  const selectedNodesFor = useCallback(
    (fallback: ExplorerNode): ExplorerNode[] => {
      const ids = selectedIds.has(fallback.id)
        ? selectedIds
        : new Set([fallback.id]);
      return Array.from(ids)
        .map((id) => nodesRef.current.get(id))
        .filter((node): node is ExplorerNode => Boolean(node));
    },
    [selectedIds],
  );

  const rememberNode = useCallback((node: ExplorerNode): (() => void) => {
    nodesRef.current.set(node.id, node);
    return () => {
      if (nodesRef.current.get(node.id) === node) {
        nodesRef.current.delete(node.id);
      }
    };
  }, []);

  const activateNode = useCallback(
    (
      node: ExplorerNode,
      event: MouseEvent<HTMLButtonElement>,
      defaultAction: () => void,
    ): void => {
      const toggle = event.metaKey || event.ctrlKey;
      const ids = visibleRowIds();
      setFocusedId(node.id);
      if (event.shiftKey && selectionAnchorId) {
        const anchorIndex = ids.indexOf(selectionAnchorId);
        const nodeIndex = ids.indexOf(node.id);
        if (anchorIndex >= 0 && nodeIndex >= 0) {
          const [start, end] = [anchorIndex, nodeIndex].sort((a, b) => a - b);
          const range = ids.slice(start, end + 1);
          setSelectedIds((current) =>
            toggle
              ? new Set([...Array.from(current), ...range])
              : new Set(range),
          );
          return;
        }
      }
      if (toggle) {
        setSelectedIds((current) => {
          const next = new Set(current);
          if (!next.delete(node.id)) next.add(node.id);
          return next;
        });
        setSelectionAnchorId(node.id);
        return;
      }
      setSelectedIds(new Set([node.id]));
      setSelectionAnchorId(node.id);
      defaultAction();
      if (node.kind === 'file') {
        noteFileOpened();
      }
    },
    [noteFileOpened, selectionAnchorId, visibleRowIds],
  );

  const openNodeContextMenu = useCallback(
    (
      node: ExplorerNode,
      _event: MouseEvent<HTMLButtonElement>,
      target: FileTreeActionTarget,
    ): void => {
      setFocusedId(node.id);
      setSelectionAnchorId(node.id);
      setSelectedIds((current) =>
        current.has(node.id) ? current : new Set([node.id]),
      );
      setActionTarget(target);
    },
    [],
  );

  const beginEditor = useCallback(
    (mode: InlineEditorMode, node: ExplorerNode): void => {
      setMutationError(null);
      if (mode !== 'rename') {
        setSearchOpen(false);
        setSearchQuery('');
        if (projectId && worktreeId) {
          const parentPath =
            node.kind === 'folder'
              ? node.relativePath
              : node.relativePath.split('/').slice(0, -1).join('/');
          const nextExpanded = new Set(expandedPaths);
          let changed = false;
          const rootTreePath = getRepoTreePath(node.root);
          if (!nextExpanded.has(rootTreePath)) {
            nextExpanded.add(rootTreePath);
            changed = true;
          }
          const segments = parentPath.split('/').filter(Boolean);
          for (let index = 1; index <= segments.length; index += 1) {
            const treePath = directoryTreePath(
              node.root,
              segments.slice(0, index).join('/'),
            );
            if (!nextExpanded.has(treePath)) {
              nextExpanded.add(treePath);
              changed = true;
            }
          }
          if (changed) {
            setFileTreeExpandedPaths(
              projectId,
              worktreeId,
              nextExpanded,
              uiStateScope,
            );
          }
        }
      }
      setInlineEditor({
        mode,
        node,
        value: mode === 'rename' ? node.name : '',
      });
    },
    [
      expandedPaths,
      projectId,
      setFileTreeExpandedPaths,
      uiStateScope,
      worktreeId,
    ],
  );

  const updateInlineEditor = useCallback((value: string): void => {
    setMutationError(null);
    setInlineEditor((current) => (current ? { ...current, value } : current));
  }, []);

  const cancelInlineEditor = useCallback((): void => {
    setInlineEditor(null);
    setMutationError(null);
  }, []);

  const transferNodes = useCallback(
    async (
      nodes: readonly ExplorerNode[],
      destination: ExplorerNode,
      operation: 'copy' | 'move',
      consumeCutClipboard = false,
    ): Promise<void> => {
      if (!projectId || !worktreeId || destination.kind !== 'folder') return;
      setMutationBusy(true);
      setMutationError(null);
      try {
        for (const source of topLevelMutationNodes(nodes)) {
          if (!source.relativePath) continue;
          const targetRelativePath = [destination.relativePath, source.name]
            .filter(Boolean)
            .join('/');
          if (
            source.root.repoId === destination.root.repoId &&
            ((operation === 'move' &&
              targetRelativePath === source.relativePath) ||
              targetRelativePath.startsWith(`${source.relativePath}/`))
          ) {
            continue;
          }
          await window.api.mutateFileTree({
            operation,
            projectId,
            worktreeId,
            source: nodeReference(source),
            target: {
              repoId: destination.root.repoId,
              relativePath: targetRelativePath,
            },
            conflict: operation === 'copy' ? 'increment' : 'error',
          });
          if (consumeCutClipboard) {
            setClipboard((current) => {
              if (!current || current.operation !== 'cut') return current;
              const remaining = current.nodes.filter(
                (node) =>
                  node.root.repoId !== source.root.repoId ||
                  (node.relativePath !== source.relativePath &&
                    (source.kind !== 'folder' ||
                      !node.relativePath.startsWith(
                        `${source.relativePath}/`,
                      ))),
              );
              return remaining.length > 0
                ? { ...current, nodes: remaining }
                : null;
            });
          }
        }
        setSelectedIds(new Set());
        void refreshVisibleDirectories();
      } catch (error) {
        setMutationError(
          error instanceof Error ? error.message : 'Unable to update files.',
        );
        void refreshVisibleDirectories();
      } finally {
        setMutationBusy(false);
      }
    },
    [projectId, refreshVisibleDirectories, worktreeId],
  );

  const submitInlineEditor = useCallback(async (): Promise<boolean> => {
    if (!inlineEditor || !projectId || !worktreeId || mutationBusy) {
      return false;
    }
    const value = inlineEditor.value.trim().replace(/\\/g, '/');
    if (!value) {
      setMutationError('Enter a file or folder name.');
      return false;
    }
    if (inlineEditor.mode === 'rename' && value.includes('/')) {
      setMutationError('Names cannot contain path separators.');
      return false;
    }
    if (inlineEditor.mode === 'rename' && value === inlineEditor.node.name) {
      setInlineEditor(null);
      setMutationError(null);
      return true;
    }
    setMutationBusy(true);
    setMutationError(null);
    try {
      if (inlineEditor.mode === 'rename') {
        const parts = inlineEditor.node.relativePath.split('/');
        parts[parts.length - 1] = value;
        await window.api.mutateFileTree({
          operation: 'move',
          projectId,
          worktreeId,
          source: nodeReference(inlineEditor.node),
          target: {
            repoId: inlineEditor.node.root.repoId,
            relativePath: parts.join('/'),
          },
          conflict: 'error',
        });
      } else {
        const parent =
          inlineEditor.node.kind === 'folder'
            ? inlineEditor.node.relativePath
            : inlineEditor.node.relativePath.split('/').slice(0, -1).join('/');
        await window.api.mutateFileTree({
          operation: inlineEditor.mode,
          projectId,
          worktreeId,
          target: {
            repoId: inlineEditor.node.root.repoId,
            relativePath: [parent, value].filter(Boolean).join('/'),
          },
        });
      }
      setInlineEditor(null);
      setSelectedIds(new Set());
      void refreshVisibleDirectories();
      return true;
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : 'Unable to update files.',
      );
      return false;
    } finally {
      setMutationBusy(false);
    }
  }, [
    inlineEditor,
    mutationBusy,
    projectId,
    refreshVisibleDirectories,
    worktreeId,
  ]);

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!projectId || !worktreeId || deleteTargets.length === 0) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      for (const node of deleteTargets) {
        if (!node.relativePath) continue;
        await window.api.mutateFileTree({
          operation: 'delete',
          projectId,
          worktreeId,
          target: nodeReference(node),
          useTrash: true,
        });
        setDeleteTargets((current) =>
          current.filter((candidate) => candidate.id !== node.id),
        );
      }
      setDeleteTargets([]);
      setSelectedIds(new Set());
      void refreshVisibleDirectories();
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : 'Unable to delete files.',
      );
      void refreshVisibleDirectories();
    } finally {
      setMutationBusy(false);
    }
  }, [deleteTargets, projectId, refreshVisibleDirectories, worktreeId]);

  const handleAction = useCallback(
    (
      action: Parameters<FileTreeActionMenuProps['onAction']>[0],
      target: FileTreeActionTarget,
    ): void => {
      if (!projectId || !worktreeId) return;
      const node = target.node;
      const nodes = selectedNodesFor(node);
      if (action === 'open' || action === 'open-side') {
        if (target.kind === 'file') {
          if (action === 'open' && onOpenFile) {
            onOpenFile({
              absolutePath: target.entry.absolutePath,
              filename: target.entry.name,
            });
            noteFileOpened();
            return;
          }
          const chatState = useChatStore.getState();
          const selectedWorktree = chatState.selectedWorktree;
          const worktree = selectedWorktree
            ? chatState.worktreeChats[worktreeKey(selectedWorktree)]
            : undefined;
          const originTab = worktree?.tabs.find(
            (candidate) => candidate.id === worktree.activeTabId,
          );
          const fileTabId = chatState.openFileTab(
            {
              absolutePath: target.entry.absolutePath,
              filename: target.entry.name,
            },
            { projectId, worktreeId },
          );
          if (
            action === 'open-side' &&
            fileTabId &&
            originTab?.kind === 'chat'
          ) {
            requestFilePanelPlacementBesideChat(fileTabId, originTab.id);
          }
          if (action === 'open') noteFileOpened();
        }
        return;
      }
      if (action === 'open-external' && target.kind === 'file') {
        void window.api.openExternalFile({
          absolutePath: target.entry.absolutePath,
        });
        return;
      }
      if (action === 'new-file' || action === 'new-folder') {
        beginEditor(
          action === 'new-file' ? 'create-file' : 'create-directory',
          node,
        );
        return;
      }
      if (action === 'cut' || action === 'copy') {
        setClipboard({ operation: action, nodes });
        return;
      }
      if (action === 'paste' && clipboard) {
        const destination =
          node.kind === 'folder'
            ? node
            : nodesRef.current.get(
                explorerNodeId(
                  node.root,
                  node.relativePath.split('/').slice(0, -1).join('/'),
                ),
              );
        if (destination) {
          void transferNodes(
            clipboard.nodes,
            destination,
            clipboard.operation === 'cut' ? 'move' : 'copy',
            clipboard.operation === 'cut',
          );
        }
        return;
      }
      if (action === 'rename' && node.relativePath) {
        beginEditor('rename', node);
        return;
      }
      if (action === 'delete') {
        setMutationError(null);
        setDeleteTargets(
          topLevelMutationNodes(
            nodes.filter((candidate) => candidate.relativePath),
          ),
        );
      }
    },
    [
      beginEditor,
      clipboard,
      noteFileOpened,
      onOpenFile,
      projectId,
      selectedNodesFor,
      transferNodes,
      worktreeId,
    ],
  );

  const handleOpenInApp = useCallback(
    (appId: string): void => {
      if (!projectId || !worktreeId) return;
      void window.api.openInApp({ projectId, worktreeId, appId });
      void window.api.savePreferences({ lastOpenApp: appId });
    },
    [projectId, worktreeId],
  );

  const focusVisibleRow = useCallback(
    (currentId: string, offset: number): void => {
      const ids = visibleRowIds();
      const currentIndex = ids.indexOf(currentId);
      const nextId =
        ids[Math.max(0, Math.min(ids.length - 1, currentIndex + offset))];
      if (!nextId) return;
      const next = hostRef.current?.querySelector<HTMLElement>(
        `[data-file-tree-id="${CSS.escape(nextId)}"]`,
      );
      next?.focus();
      next?.scrollIntoView({ block: 'nearest' });
      setFocusedId(nextId);
      setSelectedIds(new Set([nextId]));
      setSelectionAnchorId(nextId);
    },
    [visibleRowIds],
  );

  const focusAppManagedRootsGroup = useCallback((): void => {
    setFocusedId(APP_MANAGED_ROOTS_NODE_ID);
    setSelectedIds(new Set([APP_MANAGED_ROOTS_NODE_ID]));
    setSelectionAnchorId(APP_MANAGED_ROOTS_NODE_ID);
  }, []);

  const keyDownAppManagedRootsGroup = useCallback(
    (
      expanded: boolean,
      onToggle: () => void,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ): void => {
      const id = APP_MANAGED_ROOTS_NODE_ID;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusVisibleRow(id, event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        // focusVisibleRow clamps, so a full-length offset lands on an end row.
        const count = visibleRowIds().length;
        focusVisibleRow(id, event.key === 'End' ? count : -count);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (expanded) focusVisibleRow(id, 1);
        else onToggle();
      } else if (event.key === 'ArrowLeft') {
        if (!expanded) return;
        event.preventDefault();
        onToggle();
      } else if (
        event.key === 'Enter' ||
        event.key === ' ' ||
        event.key === 'Spacebar'
      ) {
        event.preventDefault();
        onToggle();
      }
    },
    [focusVisibleRow, visibleRowIds],
  );

  const handleToggleAppManagedRoots = useCallback((): void => {
    // Collapsing hides the managed rows; keep the roving focus on a mounted
    // row so the tree stays reachable from the keyboard.
    const managedNodePrefixes = rootGroups.appManaged.map(
      (root) => `${encodeURIComponent(root.repoId)}:`,
    );
    if (
      expandedPaths.has(APP_MANAGED_ROOTS_TREE_PATH) &&
      focusedId !== null &&
      managedNodePrefixes.some((prefix) => focusedId.startsWith(prefix))
    ) {
      focusAppManagedRootsGroup();
    }
    handleTogglePath(APP_MANAGED_ROOTS_TREE_PATH);
  }, [
    expandedPaths,
    focusAppManagedRootsGroup,
    focusedId,
    handleTogglePath,
    rootGroups,
  ]);

  const keyDownNode = useCallback(
    (
      node: ExplorerNode,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ): void => {
      const modifier = event.metaKey || event.ctrlKey;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusVisibleRow(node.id, event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const ids = visibleRowIds();
        const targetId = event.key === 'Home' ? ids[0] : ids[ids.length - 1];
        if (!targetId) return;
        const target = hostRef.current?.querySelector<HTMLElement>(
          `[data-file-tree-id="${CSS.escape(targetId)}"]`,
        );
        target?.focus();
        target?.scrollIntoView({ block: 'nearest' });
        setFocusedId(targetId);
        setSelectedIds(new Set([targetId]));
        setSelectionAnchorId(targetId);
        return;
      }
      if (event.key === 'ArrowRight' && node.kind === 'folder') {
        const expanded =
          event.currentTarget.getAttribute('aria-expanded') === 'true';
        event.preventDefault();
        if (!expanded) event.currentTarget.click();
        else focusVisibleRow(node.id, 1);
        return;
      }
      if (event.key === 'ArrowLeft' && node.kind === 'folder') {
        const expanded =
          event.currentTarget.getAttribute('aria-expanded') === 'true';
        if (expanded) {
          event.preventDefault();
          event.currentTarget.click();
        } else if (
          node.relativePath === '' &&
          rootGroups.appManaged.some((root) => root.repoId === node.root.repoId)
        ) {
          event.preventDefault();
          hostRef.current
            ?.querySelector<HTMLElement>(
              `[data-file-tree-id="${APP_MANAGED_ROOTS_NODE_ID}"]`,
            )
            ?.focus();
          focusAppManagedRootsGroup();
        }
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.currentTarget.click();
        return;
      }
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        setSelectedIds((current) => {
          const next = new Set(current);
          if (!next.delete(node.id)) next.add(node.id);
          return next;
        });
        return;
      }
      if (
        readOnly &&
        (event.key === 'F2' ||
          event.key === 'Delete' ||
          (event.key === 'Backspace' && event.metaKey) ||
          (modifier && ['x', 'v'].includes(event.key.toLowerCase())))
      ) {
        return;
      }
      if (event.key === 'F2') {
        event.preventDefault();
        if (node.relativePath) beginEditor('rename', node);
        return;
      }
      if (
        event.key === 'Delete' ||
        (event.key === 'Backspace' && event.metaKey)
      ) {
        event.preventDefault();
        setDeleteTargets(
          topLevelMutationNodes(
            selectedNodesFor(node).filter((item) => item.relativePath),
          ),
        );
        return;
      }
      if (modifier && ['c', 'x'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        setClipboard({
          operation: event.key.toLowerCase() === 'x' ? 'cut' : 'copy',
          nodes: selectedNodesFor(node),
        });
        return;
      }
      if (modifier && event.key.toLowerCase() === 'v' && clipboard) {
        event.preventDefault();
        const destination =
          node.kind === 'folder'
            ? node
            : nodesRef.current.get(
                explorerNodeId(
                  node.root,
                  node.relativePath.split('/').slice(0, -1).join('/'),
                ),
              );
        if (destination) {
          void transferNodes(
            clipboard.nodes,
            destination,
            clipboard.operation === 'cut' ? 'move' : 'copy',
            clipboard.operation === 'cut',
          );
        }
      }
    },
    [
      beginEditor,
      clipboard,
      focusVisibleRow,
      focusAppManagedRootsGroup,
      rootGroups,
      readOnly,
      selectedNodesFor,
      transferNodes,
      visibleRowIds,
    ],
  );

  const dragStartNode = useCallback(
    (node: ExplorerNode, event: DragEvent<HTMLButtonElement>): void => {
      const nodes = selectedNodesFor(node).filter((item) => item.relativePath);
      dragNodesRef.current = nodes;
      if (!selectedIds.has(node.id)) setSelectedIds(new Set([node.id]));
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(
        'text/plain',
        nodes.map((item) => item.relativePath).join('\n'),
      );
    },
    [selectedIds, selectedNodesFor],
  );

  const dropDestinationForNode = useCallback(
    (node: ExplorerNode): ExplorerNode | null => {
      if (node.kind === 'folder') return node;
      const parentPath = node.relativePath.split('/').slice(0, -1).join('/');
      return (
        nodesRef.current.get(explorerNodeId(node.root, parentPath)) ?? null
      );
    },
    [],
  );

  const cancelDragAutoExpand = useCallback((): void => {
    if (dragExpandTimerRef.current !== null) {
      clearTimeout(dragExpandTimerRef.current);
      dragExpandTimerRef.current = null;
    }
    dragExpandTargetIdRef.current = null;
  }, []);

  useEffect(() => cancelDragAutoExpand, [cancelDragAutoExpand]);

  const dragOverNode = useCallback(
    (node: ExplorerNode, event: DragEvent<HTMLButtonElement>): void => {
      const destination = dropDestinationForNode(node);
      if (!destination || dragNodesRef.current.length === 0) return;
      event.preventDefault();
      event.dataTransfer.dropEffect =
        event.altKey || event.ctrlKey ? 'copy' : 'move';
      setDropTargetId(destination.id);
      if (node.kind !== 'folder') {
        cancelDragAutoExpand();
        return;
      }
      if (
        event.currentTarget.getAttribute('aria-expanded') !== 'false' ||
        !projectId ||
        !worktreeId
      ) {
        cancelDragAutoExpand();
        return;
      }
      if (dragExpandTargetIdRef.current !== node.id) {
        cancelDragAutoExpand();
        dragExpandTargetIdRef.current = node.id;
        dragExpandTimerRef.current = setTimeout(() => {
          if (dragExpandTargetIdRef.current !== node.id) return;
          dragExpandTimerRef.current = null;
          dragExpandTargetIdRef.current = null;
          const treePath = node.relativePath
            ? directoryTreePath(node.root, node.relativePath)
            : getRepoTreePath(node.root);
          if (
            !useFileListStore
              .getState()
              .fileTreeExpandedPaths[uiStateKey ?? '']?.has(treePath)
          ) {
            toggleFileTreeExpandedPath(
              projectId,
              worktreeId,
              treePath,
              uiStateScope,
            );
          }
        }, DRAG_AUTO_EXPAND_DELAY_MS);
      }
    },
    [
      cancelDragAutoExpand,
      dropDestinationForNode,
      projectId,
      toggleFileTreeExpandedPath,
      uiStateKey,
      uiStateScope,
      worktreeId,
    ],
  );

  const dragLeaveNode = useCallback(
    (node: ExplorerNode, event: DragEvent<HTMLButtonElement>): void => {
      const nextTarget = event.relatedTarget;
      if (
        nextTarget instanceof Node &&
        event.currentTarget.contains(nextTarget)
      ) {
        return;
      }
      if (dragExpandTargetIdRef.current === node.id) {
        cancelDragAutoExpand();
      }
    },
    [cancelDragAutoExpand],
  );

  const dropOnNode = useCallback(
    (node: ExplorerNode, event: DragEvent<HTMLButtonElement>): void => {
      if (readOnly) return;
      const destination = dropDestinationForNode(node);
      if (!destination) return;
      event.preventDefault();
      const operation = event.altKey || event.ctrlKey ? 'copy' : 'move';
      const sources = dragNodesRef.current;
      dragNodesRef.current = [];
      cancelDragAutoExpand();
      setDropTargetId(null);
      void transferNodes(sources, destination, operation);
    },
    [cancelDragAutoExpand, dropDestinationForNode, readOnly, transferNodes],
  );

  const dragEnd = useCallback((): void => {
    dragNodesRef.current = [];
    cancelDragAutoExpand();
    setDropTargetId(null);
  }, [cancelDragAutoExpand]);

  const handleTreeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        const ids = visibleRowIds();
        setSelectedIds(new Set(ids));
        if (ids[0]) {
          setFocusedId(ids[0]);
          setSelectionAnchorId(ids[0]);
        }
        return;
      }
      if (
        event.target === event.currentTarget &&
        ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
      ) {
        event.preventDefault();
        const ids = visibleRowIds();
        const id =
          event.key === 'ArrowUp' || event.key === 'End'
            ? ids[ids.length - 1]
            : ids[0];
        if (!id) return;
        hostRef.current
          ?.querySelector<HTMLElement>(
            `[data-file-tree-id="${CSS.escape(id)}"]`,
          )
          ?.focus();
        setFocusedId(id);
        setSelectedIds(new Set([id]));
        setSelectionAnchorId(id);
      }
    },
    [visibleRowIds],
  );

  const interactionValue = useMemo<ExplorerInteractionValue>(
    () => ({
      selectedIds,
      focusedId,
      currentFileId: currentFileTarget?.nodeId ?? null,
      openFile,
      activate: activateNode,
      openContextMenu: openNodeContextMenu,
      keyDown: keyDownNode,
      dragStart: dragStartNode,
      dragOver: dragOverNode,
      dragLeave: dragLeaveNode,
      drop: dropOnNode,
      dragEnd,
      dropTargetId,
      remember: rememberNode,
      inlineEditor,
      mutationBusy,
      mutationError,
      updateInlineEditor,
      submitInlineEditor,
      cancelInlineEditor,
    }),
    [
      activateNode,
      cancelInlineEditor,
      currentFileTarget,
      dragEnd,
      dragLeaveNode,
      dragOverNode,
      dragStartNode,
      dropOnNode,
      dropTargetId,
      focusedId,
      inlineEditor,
      keyDownNode,
      mutationBusy,
      mutationError,
      openFile,
      openNodeContextMenu,
      rememberNode,
      selectedIds,
      submitInlineEditor,
      updateInlineEditor,
    ],
  );

  const handleToolbarCreate = useCallback(
    (mode: 'create-file' | 'create-directory'): void => {
      const selectedNode = Array.from(selectedIds)
        .map((id) => nodesRef.current.get(id))
        .find(Boolean);
      let target = selectedNode;
      if (target?.kind === 'file') {
        target = nodesRef.current.get(
          explorerNodeId(
            target.root,
            target.relativePath.split('/').slice(0, -1).join('/'),
          ),
        );
      }
      const firstRoot = roots[0];
      if (!target && firstRoot) {
        target = {
          id: explorerNodeId(firstRoot, ''),
          kind: 'folder',
          name: firstRoot.repoName,
          relativePath: '',
          absolutePath: firstRoot.absolutePath,
          root: firstRoot,
          repoCount: roots.length,
        };
      }
      if (target) beginEditor(mode, target);
    },
    [beginEditor, roots, selectedIds],
  );

  const handleCollapseAll = useCallback((): void => {
    if (!projectId || !worktreeId) return;
    cancelPendingCurrentFileScroll();
    setFileTreeExpandedPaths(projectId, worktreeId, new Set(), uiStateScope);
    setActionTarget(null);
  }, [
    cancelPendingCurrentFileScroll,
    projectId,
    setFileTreeExpandedPaths,
    uiStateScope,
    worktreeId,
  ]);

  const handleTreeContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      if (event.target !== event.currentTarget) return;
      const root = roots[0];
      if (!root) return;
      event.preventDefault();
      const node: ExplorerNode = {
        id: explorerNodeId(root, ''),
        kind: 'folder',
        name: root.repoName,
        relativePath: '',
        absolutePath: root.absolutePath,
        root,
        repoCount: roots.length,
      };
      setSelectedIds(new Set([node.id]));
      setFocusedId(node.id);
      setActionTarget({
        kind: 'folder',
        node,
        copyPath: '.',
        absolutePath: root.absolutePath,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [roots],
  );

  const filteredPrimaryEntries = filteredResults.entries.filter(
    ({ root }) => !rootGroups.appManaged.includes(root),
  );
  const filteredManagedEntries = filteredResults.entries.filter(({ root }) =>
    rootGroups.appManaged.includes(root),
  );
  // Search reveals matches inside the group without touching its saved
  // expansion; collapsing it here is temporary to the current query.
  const filteredManagedExpanded = !collapsedSearchPaths.has(
    APP_MANAGED_ROOTS_TREE_PATH,
  );
  const toggleFilteredManagedRoots = (): void => {
    focusAppManagedRootsGroup();
    handleToggleFilteredPath(APP_MANAGED_ROOTS_TREE_PATH);
  };
  const renderFilteredRoot = (
    {
      root,
      nodes,
    }: { root: FileTreeRoot; nodes: readonly FilteredFileTreeNode[] },
    depth: number,
  ): JSX.Element => {
    const treePath = getRepoTreePath(root);
    const isExpanded = !collapsedSearchPaths.has(treePath);
    return (
      <div key={treePath}>
        <FolderRow
          label={root.repoName}
          replayMaskLabel={isCoworkWorkspaceFileTreeRoot(root)}
          depth={depth}
          expanded={isExpanded}
          isRepo
          onToggle={() => handleToggleFilteredPath(treePath)}
          copyPath="."
          absolutePath={root.absolutePath}
          relativePath=""
          root={root}
          repoCount={roots.length}
          onActionMenu={handleOpenActionMenu}
          onOpenInFileManager={handleOpenInFileManager}
        />
        {isExpanded && (
          <FilteredNodes
            nodes={nodes}
            root={root}
            repoCount={roots.length}
            depth={depth + 1}
            collapsedPaths={collapsedSearchPaths}
            onToggle={handleToggleFilteredPath}
            onActionMenu={handleOpenActionMenu}
            onOpenInFileManager={handleOpenInFileManager}
          />
        )}
      </div>
    );
  };
  const managedRootsExpanded = expandedPaths.has(APP_MANAGED_ROOTS_TREE_PATH);
  const toggleManagedRoots = (): void => {
    focusAppManagedRootsGroup();
    handleToggleAppManagedRoots();
  };
  const renderRoot = (
    root: FileTreeRoot,
    depth: number,
    scope: { projectId: string; worktreeId: string },
  ): JSX.Element => (
    <RootRenderer
      key={getRepoTreePath(root)}
      projectId={scope.projectId}
      worktreeId={scope.worktreeId}
      root={root}
      repoCount={roots.length}
      depth={depth}
      expandedPaths={expandedPaths}
      onToggle={handleTogglePath}
      onActionMenu={handleOpenActionMenu}
      onOpenInFileManager={handleOpenInFileManager}
    />
  );

  let body: JSX.Element;
  if (!projectId || !worktreeId) {
    body = (
      <div className="flex items-center justify-center px-4 py-12 text-s fg-secondary">
        No worktree selected.
      </div>
    );
  } else if (searchActive) {
    if ((indexError && !indexEntry) || (rootsError && !rootsEntry)) {
      body = (
        <ErrorState
          space="panel"
          message="Couldn’t search files."
          testId="files-tree-search-error"
        />
      );
    } else if (!indexEntry || !renderedRootsEntry) {
      // Both data sets are required to key results by root. Before their first
      // requests dispatch, absence still means loading rather than empty.
      body = (
        <DelayedLoadingPlaceholder className="">
          <div className="box-content flex min-h-full flex-1 py-12">
            <CenteredLoadingSpinner className="" />
          </div>
        </DelayedLoadingPlaceholder>
      );
    } else if (filteredResults.matchCount === 0) {
      body = (
        <>
          <div
            className="flex items-center justify-center px-4 py-12 text-s fg-secondary"
            data-testid="files-tree-search-empty"
          >
            No files match “{debouncedQuery}”.
          </div>
          {indexTruncated && (
            <div
              className="px-3 py-2 text-3xs fg-secondary"
              data-testid="files-tree-index-truncated"
            >
              Search scanned a limited number of files, so some matching paths
              may be missing.
            </div>
          )}
        </>
      );
    } else {
      body = (
        <>
          {filteredPrimaryEntries.map((entry) => renderFilteredRoot(entry, 0))}
          {filteredManagedEntries.length > 0 && (
            <div>
              <FileRootGroupRow
                label={brandText.appName}
                expanded={filteredManagedExpanded}
                onToggle={toggleFilteredManagedRoots}
                nodeId={APP_MANAGED_ROOTS_NODE_ID}
                selected={selectedIds.has(APP_MANAGED_ROOTS_NODE_ID)}
                tabIndex={focusedId === APP_MANAGED_ROOTS_NODE_ID ? 0 : -1}
                onKeyDown={(event): void =>
                  keyDownAppManagedRootsGroup(
                    filteredManagedExpanded,
                    toggleFilteredManagedRoots,
                    event,
                  )
                }
                dataTestId="files-tree-root-group"
              />
              {filteredManagedExpanded &&
                filteredManagedEntries.map((entry) =>
                  renderFilteredRoot(entry, 1),
                )}
            </div>
          )}
          {filteredResults.shownCount < filteredResults.matchCount && (
            <div
              className="px-3 py-2 text-3xs fg-secondary"
              data-testid="files-tree-search-truncated"
            >
              Showing {filteredResults.shownCount} of{' '}
              {filteredResults.matchCount} matches. Narrow the search to see the
              rest.
            </div>
          )}
          {indexTruncated && (
            <div
              className="px-3 py-2 text-3xs fg-secondary"
              data-testid="files-tree-index-truncated"
            >
              Search scanned a limited number of files, so some matching paths
              may be missing.
            </div>
          )}
        </>
      );
    }
  } else if (rootsLoading && !renderedRootsEntry) {
    body = (
      <DelayedLoadingPlaceholder className="">
        <div className="box-content flex min-h-full flex-1 py-12">
          <CenteredLoadingSpinner className="" />
        </div>
      </DelayedLoadingPlaceholder>
    );
  } else if (rootsError && !renderedRootsEntry) {
    body = <ErrorState space="panel" message="Couldn’t load files." />;
  } else if (renderedRootsEntry && roots.length === 0) {
    body = (
      <div className="flex items-center justify-center px-4 py-12 text-s fg-secondary">
        No files found.
      </div>
    );
  } else {
    const scope = { projectId, worktreeId };
    body = (
      <>
        {rootGroups.primary.map((root) => renderRoot(root, 0, scope))}
        {rootGroups.appManaged.length > 0 && (
          <div>
            <FileRootGroupRow
              label={brandText.appName}
              expanded={managedRootsExpanded}
              onToggle={toggleManagedRoots}
              nodeId={APP_MANAGED_ROOTS_NODE_ID}
              selected={selectedIds.has(APP_MANAGED_ROOTS_NODE_ID)}
              tabIndex={focusedId === APP_MANAGED_ROOTS_NODE_ID ? 0 : -1}
              onKeyDown={(event): void =>
                keyDownAppManagedRootsGroup(
                  managedRootsExpanded,
                  handleToggleAppManagedRoots,
                  event,
                )
              }
              dataTestId="files-tree-root-group"
            />
            {managedRootsExpanded &&
              rootGroups.appManaged.map((root) => renderRoot(root, 1, scope))}
          </div>
        )}
      </>
    );
  }

  const refreshDisabled = !projectId || !worktreeId || rootsLoading;

  return (
    <div
      ref={hostRef}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="files-tree-tab"
      data-watching={watching ? 'true' : 'false'}
    >
      {searchShortcutActive && projectId && worktreeId && (
        <FileTreeSearchUiStateReporter
          projectId={projectId}
          worktreeId={worktreeId}
          open={searchOpen}
          filtering={searchActive}
        />
      )}
      {onTreeModeChange ? (
        <EmbeddedFileTreeToolbar
          mode="file"
          onModeChange={onTreeModeChange}
          searchOpen={searchOpen}
          onToggleSearch={handleToggleSearch}
          onFocusFile={revealCurrentFile}
          focusDisabled={!currentFileTarget}
          onRefresh={handleRefresh}
          refreshDisabled={refreshDisabled}
          onCollapseAll={handleCollapseAll}
          collapseDisabled={
            !projectId || !worktreeId || expandedPaths.size === 0
          }
          onNewFile={() => handleToolbarCreate('create-file')}
          onNewFolder={() => handleToolbarCreate('create-directory')}
          createDisabled={!projectId || !worktreeId || roots.length === 0}
        />
      ) : (
        <Surface variant="section" boundary="bottom">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-3xs font-medium fg-secondary">Files</span>
            <div className="flex items-center gap-0.5">
              <Tooltip label="New file…">
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly
                  onClick={() => handleToolbarCreate('create-file')}
                  disabled={!projectId || !worktreeId || roots.length === 0}
                  data-testid="files-tree-new-file"
                  aria-label="New file…"
                >
                  <PlusIcon size="sm" />
                </Button>
              </Tooltip>
              <Tooltip label="New folder…">
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly
                  onClick={() => handleToolbarCreate('create-directory')}
                  disabled={!projectId || !worktreeId || roots.length === 0}
                  data-testid="files-tree-new-folder"
                  aria-label="New folder…"
                >
                  <FolderPlusIcon size="sm" />
                </Button>
              </Tooltip>
              <Tooltip label="Search files">
                <Button
                  variant="ghost-quiet"
                  size="compact"
                  iconOnly
                  onClick={handleToggleSearch}
                  data-testid="files-tree-search-toggle"
                  aria-expanded={searchOpen}
                  aria-label="Search files"
                >
                  <SearchIcon size="sm" />
                </Button>
              </Tooltip>
              {currentFilePath && (
                <Tooltip label="Jump to file">
                  <Button
                    variant="ghost"
                    size="compact"
                    iconOnly
                    onClick={revealCurrentFile}
                    disabled={!currentFileTarget}
                    data-testid="files-tree-jump-to-file"
                    aria-label="Jump to file"
                  >
                    <FocusSquareIcon size="sm" />
                  </Button>
                </Tooltip>
              )}
              <FilesTreeRefreshButton
                onClick={handleRefresh}
                disabled={refreshDisabled}
                spinning={rootsLoading}
                density="compact"
                showTooltip={false}
              />
              <Tooltip label="Collapse all">
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly
                  onClick={handleCollapseAll}
                  disabled={
                    !projectId || !worktreeId || expandedPaths.size === 0
                  }
                  data-testid="files-tree-collapse-all"
                  aria-label="Collapse all"
                >
                  <ChevronUp className="h-3 w-3" />
                </Button>
              </Tooltip>
            </div>
          </div>
        </Surface>
      )}
      {searchOpen && (
        <Surface variant="section" boundary="bottom">
          <div
            className="flex items-center gap-1.5 px-2 py-1.5"
            data-testid="files-tree-search"
          >
            <SearchField
              ref={searchInputRef}
              className="flex-1"
              value={searchQuery}
              onValueChange={setSearchQuery}
              onKeyDown={handleSearchKeyDown}
              placeholder="Filter files…"
              data-testid="files-tree-search-input"
              aria-label="Filter files"
              clearLabel="Clear file filter"
              clearTestId="files-tree-search-clear"
            />
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={handleCloseSearch}
              data-testid="files-tree-search-close"
              aria-label="Close file search"
            >
              <CloseIcon size="sm" />
            </Button>
          </div>
        </Surface>
      )}
      {!inlineEditor && mutationError && (
        <Surface variant="section" boundary="bottom">
          <div className="px-3 py-1.5">
            <ErrorBanner error={mutationError} className="" />
          </div>
        </Surface>
      )}
      <div
        ref={scrollRef}
        onWheelCapture={handleCapturedUserScrollIntent}
        onScrollCapture={handleCapturedScroll}
        onKeyDown={handleTreeKeyDown}
        onContextMenu={handleTreeContextMenu}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelectedIds(new Set());
        }}
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-1"
        data-testid="files-tree-scroll"
        role="tree"
        aria-label="Project files"
        aria-multiselectable="true"
        tabIndex={0}
      >
        <ExplorerInteractionContext.Provider value={interactionValue}>
          {body}
        </ExplorerInteractionContext.Provider>
      </div>
      {actionTarget !== null && !readOnly && (
        <FileTreeActionMenu
          target={actionTarget}
          onClose={handleCloseActionMenu}
          onOpenInFileManager={handleOpenInFileManager}
          onAction={handleAction}
          onOpenInApp={handleOpenInApp}
          canPaste={clipboard !== null}
          startPageState={((): FileTreeActionMenuProps['startPageState'] => {
            if (
              !startPageEnabled ||
              !projectId ||
              !projectType ||
              actionTarget.kind !== 'file'
            ) {
              return undefined;
            }
            const candidate = startPageFromAbsolutePath(
              actionTarget.entry.absolutePath,
              [actionTarget.root],
              projectType,
            );
            if (!candidate) return undefined;
            const isStartPage = startPagesEqual(
              candidate,
              resolvedStartPage?.startPage,
            );
            return {
              isStartPage,
              toggle: (): void => {
                void saveStartPageFromAction(
                  projectId,
                  isStartPage ? null : candidate,
                );
              },
            };
          })()}
        />
      )}
      {deleteTargets.length > 0 && (
        <ConfirmDialog
          title={`Delete ${deleteTargets.length === 1 ? deleteTargets[0].name : `${deleteTargets.length} items`}?`}
          message="The selected files and folders will be moved to the system trash or recycle bin."
          confirmLabel="Delete"
          busyLabel="Deleting…"
          busy={mutationBusy}
          errorMessage={mutationError}
          destructive
          onCancel={() => {
            setDeleteTargets([]);
            setMutationError(null);
          }}
          onConfirm={() => void confirmDelete()}
          dataTestId="files-tree-delete-confirm"
          confirmTestId="files-tree-delete-confirm-button"
        />
      )}
    </div>
  );
}
