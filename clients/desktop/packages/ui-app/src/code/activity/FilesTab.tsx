'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type MouseEvent,
  type KeyboardEvent,
} from 'react';
import { ConfirmDialog } from '@canopy/ui-shared';
import {
  PlusIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
  FolderIcon,
  FileTypeIcon,
  MentionIcon,
} from '@canopy/ui-shared/icons';
import {
  FilesTabActionMenu,
  type FilesTabActionTarget,
  type FilesTabMenuAction,
} from './FilesTabActionMenu';
import {
  validateFilesTabEditorValue,
  parentDirOf,
  type FilesTabInlineEditorState,
} from './files-tab-inline-editor';
import {
  FILES_TAB_SEARCH_DEBOUNCE_MS,
  buildFilesTabSearchTree,
  flattenFilesTabSearchTree,
} from './files-tab-search';
import type {
  PortalCodeViewerSelection,
  PortalFileTreeNode,
} from '@canopy/protocol/portal';
import {
  Surface,
  FileRootGroupRow,
  FileTreeRow,
  SearchField,
  TextInput,
  ErrorBanner,
  Notice,
  FieldError,
} from '@canopy/ui-shared/components';
import {
  isCoworkWorkspaceFileRoot,
  partitionFileRoots,
  type FileRootGroupKind,
} from '@canopy/ui-shared/lib/file-root-groups';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { DownloadIcon } from '@canopy/ui-shared/icons';
import { Button, Tooltip } from '@canopy/ui-shared/components';
import {
  DelayedLoadingPlaceholder,
  FilesTreeRefreshButton,
  Skeleton,
  useIconStyle,
} from '@canopy/ui-shared/components';
import {
  CloseIcon,
  FolderPlusIcon as CentralFolderPlusIcon,
  PlusIcon as CentralPlusIcon,
  SearchIcon as CentralSearchIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/** Plain tree rows the loading skeleton measures: two folders, two files. */
const SAMPLE_TREE_ENTRIES: readonly {
  readonly name: string;
  readonly isDir: boolean;
}[] = [
  { name: 'docs', isDir: true },
  { name: 'src', isDir: true },
  { name: 'package.json', isDir: false },
  { name: 'README.md', isDir: false },
];

export interface FilesTabMutations {
  readonly onCreateFile: (parentDir: string, name: string) => Promise<void>;
  readonly onCreateFolder: (parentDir: string, name: string) => Promise<void>;
  readonly onRename: (relativePath: string, newName: string) => Promise<void>;
  readonly onDelete: (relativePath: string, isDir: boolean) => Promise<void>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClearError: () => void;
}
export interface FilesTabSearch {
  readonly index:
    | { readonly paths: readonly string[]; readonly truncated: boolean }
    | undefined;
  readonly loading: boolean;
  readonly error?: string;
  readonly onEnsureIndex: () => void;
}

/** One selectable file root (repo) shown in the multi-root switcher. */
export interface FilesTabRoot {
  readonly localId: string;
  readonly label: string;
  /** Stable catalog kind; absent from older hosts, which never group. */
  readonly kind?: FileRootGroupKind;
}

function readRootGroupExpansion(key: string | undefined): boolean {
  try {
    return (
      key !== undefined &&
      typeof window !== 'undefined' &&
      window.localStorage.getItem(key) === 'true'
    );
  } catch {
    return false;
  }
}

function saveRootGroupExpansion(
  key: string | undefined,
  expanded: boolean,
): void {
  try {
    if (key !== undefined) window.localStorage.setItem(key, String(expanded));
  } catch {
    // A disabled browser store must not prevent operating the disclosure.
  }
}

/**
 * Files tab for the activity panel: a flat listing of one directory's entries
 * via the shared {@link FileTreeRow}. `PortalFileTreeNode` is a per-directory
 * cache (`{ name, isDir }`), so lazy expansion (loading a directory's children
 * on click) is a host action wired by the adopt tickets — here directories call
 * {@link FilesTabProps.onOpenDirectory} and files call
 * {@link FilesTabProps.onOpenFile}.
 *
 * Entry `name`s are plain names within `currentDir`; this component joins them
 * onto `currentDir` so every callback and file-selection request receives the
 * root-relative path. Multi-root hosts pass `roots` / `activeRootLocalId` /
 * `onSelectRoot` to render the root switcher, and `currentDir` drives the
 * breadcrumb with `../` up-navigation.
 */
export interface FilesTabProps {
  readonly mutations?: FilesTabMutations;
  readonly canMutatePath?: (relativePath: string) => boolean;
  readonly onReload?: () => void;
  readonly reloading?: boolean;
  readonly onMentionInChat?: (relativePath: string) => void;
  readonly canMentionPath?: (relativePath: string) => boolean;
  readonly search?: FilesTabSearch;
  /** One directory's listing: plain entry names within `currentDir`. */
  readonly entries: readonly PortalFileTreeNode[];
  readonly onOpenFile?: (name: string) => void;
  readonly onOpenDirectory?: (name: string) => void;
  /**
   * Host saves one file to disk; receives the root-relative path. Provided only
   * where a download transport exists. Hosts can further restrict individual
   * rows with `canDownloadFile`; the package stays transport-agnostic and only
   * raises the intent.
   */
  readonly onDownloadFile?: (relativePath: string) => void;
  /** Optional host policy that limits the download action to eligible paths. */
  readonly canDownloadFile?: (relativePath: string) => boolean;
  /**
   * Host copy for the most recent failed download. Rendered in the notice bar
   * because the row action itself has nowhere to report to — without it a
   * failed download (expired sandbox, no credits) is silent.
   */
  readonly downloadError?: string;
  /** Neutral saved-copy download provenance. */
  readonly downloadNotice?: string;
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly fileRootLocalId?: string;
  readonly onSelectFile?: (selection: PortalCodeViewerSelection) => void;
  /** All selectable file roots; a switcher renders when there is more than one. */
  readonly roots?: readonly FilesTabRoot[];
  readonly activeRootLocalId?: string;
  readonly onSelectRoot?: (rootLocalId: string) => void;
  /**
   * Brand display name for the group holding app-owned roots. The switcher
   * groups those roots only when the host supplies it.
   */
  readonly appManagedRootsLabel?: string;
  /** Root-relative directory currently listed; empty string is the root. */
  readonly currentDir?: string;
  /** Show a loading placeholder instead of the empty state. */
  readonly loading?: boolean;
  readonly dataTestId?: string;
  readonly rowDataTestId?: string;
  /** Directory rows use this testid instead of `rowDataTestId` when set. */
  readonly folderRowDataTestId?: string;
  readonly touchTarget?: boolean;
  /** Host-rendered recovery UI replacing the default empty copy. */
  readonly emptyState?: ReactNode;
  /** Host status shown above and alongside entries. */
  readonly statusBar?: ReactNode;
  /** The host stopped at its 2,000-entry directory bound. */
  readonly truncated?: boolean;
}

export function FilesTab({
  entries,
  mutations,
  canMutatePath,
  onReload,
  reloading = false,
  onMentionInChat,
  canMentionPath,
  search,
  onOpenFile,
  onOpenDirectory,
  onDownloadFile,
  canDownloadFile,
  downloadError,
  downloadNotice,
  workspaceLocalId,
  worktreeLocalId,
  fileRootLocalId,
  onSelectFile,
  roots,
  activeRootLocalId,
  onSelectRoot,
  appManagedRootsLabel,
  currentDir,
  loading,
  dataTestId,
  rowDataTestId,
  folderRowDataTestId,
  touchTarget,
  emptyState,
  statusBar,
  truncated = false,
}: FilesTabProps): JSX.Element {
  const dir = currentDir ?? '';
  const joinDir = (name: string): string => (dir ? `${dir}/${name}` : name);
  const parentDir = dir.split('/').slice(0, -1).join('/');

  // Hosts that opt into the `central` icon style (desktop early access) draw the
  // toolbar with them; others keep the classic icons.
  const centralIcons = useIconStyle() === 'central';
  const NewFileIcon = centralIcons ? CentralPlusIcon : PlusIcon;
  const NewFolderIcon = centralIcons ? CentralFolderPlusIcon : FolderPlusIcon;
  const SearchFilesIcon = centralIcons
    ? CentralSearchIcon
    : MagnifyingGlassIcon;

  const [editor, setEditor] = useState<FilesTabInlineEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorDir, setEditorDir] = useState(dir);
  // Discard drafts before rendering another directory; context-menu creation
  // may intentionally target a child folder while the listing stays here.
  if (editorDir !== dir) {
    setEditorDir(dir);
    setEditor(null);
    setEditorError(null);
  }
  const [actionError, setActionError] = useState<string | null>(null);
  const [menu, setMenu] = useState<FilesTabActionTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Omit<
    FilesTabActionTarget,
    'x' | 'y'
  > | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [collapsedResults, setCollapsedResults] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const rootGroups = useMemo(
    () =>
      appManagedRootsLabel === undefined
        ? { primary: roots ?? [], appManaged: [] }
        : partitionFileRoots(roots ?? [], (root) => ({
            id: root.localId,
            kind: root.kind,
          })),
    [appManagedRootsLabel, roots],
  );
  const activeRootIsManaged = rootGroups.appManaged.some(
    (root) => root.localId === activeRootLocalId,
  );
  const rootGroupStateKey =
    workspaceLocalId && worktreeLocalId
      ? `canopy:files-root-group:${JSON.stringify([workspaceLocalId, worktreeLocalId, dataTestId ?? 'activity'])}`
      : undefined;
  const [rootGroupState, setRootGroupState] = useState(() => ({
    key: rootGroupStateKey,
    activeRootLocalId,
    activeRootIsManaged,
    expanded: activeRootIsManaged || readRootGroupExpansion(rootGroupStateKey),
  }));
  if (
    rootGroupState.key !== rootGroupStateKey ||
    rootGroupState.activeRootLocalId !== activeRootLocalId ||
    rootGroupState.activeRootIsManaged !== activeRootIsManaged
  ) {
    setRootGroupState({
      key: rootGroupStateKey,
      activeRootLocalId,
      activeRootIsManaged,
      expanded:
        rootGroupState.key !== rootGroupStateKey
          ? activeRootIsManaged || readRootGroupExpansion(rootGroupStateKey)
          : activeRootIsManaged || rootGroupState.expanded,
    });
  }
  const managedRootsExpanded = rootGroupState.expanded;
  const toggleManagedRoots = (): void => {
    const expanded = !managedRootsExpanded;
    saveRootGroupExpansion(rootGroupStateKey, expanded);
    setRootGroupState({ ...rootGroupState, expanded });
  };
  const managedRootsGroupId = useId();
  const editorErrorId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const editorInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  useEffect(() => {
    if (!searchQuery.trim()) {
      setDebouncedQuery('');
      return;
    }
    const timer = window.setTimeout(
      () => setDebouncedQuery(searchQuery.trim()),
      FILES_TAB_SEARCH_DEBOUNCE_MS,
    );
    return (): void => window.clearTimeout(timer);
  }, [searchQuery]);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);
  const editorIdentity =
    editor === null
      ? null
      : `${editor.mode}:${editor.parentDir}:${editor.targetPath ?? ''}`;
  useEffect(() => {
    if (editorIdentity !== null) {
      editorInputRef.current?.focus();
      editorInputRef.current?.select();
    }
  }, [editorIdentity]);
  const searchActive =
    searchOpen && debouncedQuery.length > 0 && search !== undefined;
  useEffect(() => {
    if (
      searchActive &&
      search.index === undefined &&
      !search.loading &&
      search.error === undefined
    )
      search.onEnsureIndex();
  }, [searchActive, search]);
  const results = useMemo(
    () =>
      searchActive && search?.index !== undefined
        ? buildFilesTabSearchTree(search.index.paths, debouncedQuery)
        : null,
    [searchActive, search?.index, debouncedQuery],
  );
  const mutable = (path: string): boolean =>
    mutations !== undefined && (canMutatePath?.(path) ?? true);
  const mentionable = (
    target: Omit<FilesTabActionTarget, 'x' | 'y'>,
  ): boolean =>
    onMentionInChat !== undefined &&
    !target.savedCopy &&
    target.kind === 'file' &&
    (canMentionPath?.(target.relativePath) ?? true);
  const rowActions = (
    target: Omit<FilesTabActionTarget, 'x' | 'y'>,
  ): JSX.Element | undefined => {
    const showMention = mentionable(target);
    const showDownload =
      onDownloadFile !== undefined &&
      target.kind === 'file' &&
      (canDownloadFile?.(target.relativePath) ?? true);
    if (!showMention && !showDownload) return undefined;
    return (
      <div className="flex items-center gap-0.5 rounded-md bg-base">
        {showMention && (
          <Tooltip label={`Mention ${target.name} in chat`}>
            <button
              type="button"
              data-testid="activity-files-mention"
              aria-label={`Mention ${target.name} in chat`}
              className="focus-ring flex items-center rounded-md bg-base p-1 fg-secondary ring-1 ring-inset ring-line-base transition-colors hover:fg-primary"
              onPointerDown={(event): void => event.stopPropagation()}
              onMouseDown={(event): void => event.stopPropagation()}
              onClick={(event): void => {
                event.stopPropagation();
                event.preventDefault();
                onMentionInChat?.(target.relativePath);
              }}
            >
              <MentionIcon size="sm" />
            </button>
          </Tooltip>
        )}
        {showDownload && (
          <Tooltip label={`Download ${target.name}`}>
            <button
              type="button"
              data-testid="activity-files-download"
              aria-label={`Download ${target.name}`}
              className="focus-ring flex items-center rounded-md bg-base p-1 fg-secondary ring-1 ring-inset ring-line-base transition-colors hover:fg-primary"
              onPointerDown={(event): void => event.stopPropagation()}
              onMouseDown={(event): void => event.stopPropagation()}
              onClick={(event): void => {
                event.stopPropagation();
                event.preventDefault();
                onDownloadFile?.(target.relativePath);
              }}
            >
              <DownloadIcon size="sm" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
    );
  };
  const beginCreate = (
    mode: 'create-file' | 'create-directory',
    parentDir: string,
  ): void => {
    if (!mutable(parentDir) || mutations?.busy) return;
    mutations?.onClearError();
    setEditorError(null);
    setEditor({
      mode,
      parentDir,
      isDir: mode === 'create-directory',
      value: '',
    });
  };
  const beginRename = (target: Omit<FilesTabActionTarget, 'x' | 'y'>): void => {
    if (!mutable(target.relativePath) || target.savedCopy || mutations?.busy)
      return;
    mutations?.onClearError();
    setEditorError(null);
    setEditor({
      mode: 'rename',
      parentDir: parentDirOf(target.relativePath),
      targetPath: target.relativePath,
      originalName: target.name,
      isDir: target.kind === 'directory',
      value: target.name,
    });
  };
  const submitEditor = async (): Promise<void> => {
    if (
      editor === null ||
      mutations === undefined ||
      mutations.busy ||
      submittingRef.current ||
      !mutable(editor.targetPath ?? editor.parentDir)
    )
      return;
    const validation = validateFilesTabEditorValue(editor);
    if (!validation.ok) {
      setEditorError(validation.error);
      return;
    }
    if (validation.unchanged) {
      setEditor(null);
      return;
    }
    submittingRef.current = true;
    try {
      if (editor.mode === 'rename' && editor.targetPath !== undefined)
        await mutations.onRename(editor.targetPath, validation.value);
      else if (editor.mode === 'create-directory')
        await mutations.onCreateFolder(editor.parentDir, validation.value);
      else await mutations.onCreateFile(editor.parentDir, validation.value);
      setEditor(null);
    } catch (error) {
      setEditorError(
        error instanceof Error
          ? error.message
          : 'Couldn’t update files. Try again.',
      );
    } finally {
      submittingRef.current = false;
    }
  };
  const openMenu =
    (
      target: Omit<FilesTabActionTarget, 'x' | 'y'>,
    ): ((event: MouseEvent<HTMLElement>) => void) =>
    (event): void => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ ...target, x: event.clientX, y: event.clientY });
    };
  const closeSearch = (): void => {
    setSearchOpen(false);
    setSearchQuery('');
  };
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'f' &&
      search !== undefined
    ) {
      event.preventDefault();
      setSearchOpen(true);
      searchInputRef.current?.focus();
    } else if (event.key === 'Escape') {
      if (menu !== null) setMenu(null);
      else if (editor !== null && !mutations?.busy) setEditor(null);
      else if (searchOpen) closeSearch();
    }
  };
  const rowKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    target: Omit<FilesTabActionTarget, 'x' | 'y'>,
  ): void => {
    if (
      event.key === 'ContextMenu' ||
      (event.shiftKey && event.key === 'F10')
    ) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ ...target, x: rect.left, y: rect.bottom });
      return;
    }
    if (!mutable(target.relativePath) || target.savedCopy || mutations?.busy)
      return;
    if (event.key === 'F2') {
      event.preventDefault();
      beginRename(target);
    } else if (
      event.key === 'Delete' ||
      (event.metaKey && event.key === 'Backspace')
    ) {
      event.preventDefault();
      setDeleteError(null);
      setDeleteTarget(target);
    }
  };
  const openFile = (relativePath: string, name: string): void => {
    if (onSelectFile && workspaceLocalId && worktreeLocalId && fileRootLocalId)
      onSelectFile({
        kind: 'file',
        title: name,
        request: {
          projectId: workspaceLocalId,
          worktreeId: worktreeLocalId,
          fileRootLocalId,
          relativePath,
        },
      });
    else onOpenFile?.(relativePath);
  };
  const copyPath = async (relativePath: string): Promise<void> => {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(relativePath);
    } catch {
      setActionError("Couldn't copy the path. Try again.");
    }
  };
  const onMenuAction = (
    action: FilesTabMenuAction,
    target: FilesTabActionTarget,
  ): void => {
    switch (action) {
      case 'new-file':
      case 'new-folder':
        if (!target.savedCopy)
          beginCreate(
            action === 'new-file' ? 'create-file' : 'create-directory',
            target.kind === 'file'
              ? parentDirOf(target.relativePath)
              : target.relativePath,
          );
        break;
      case 'open':
        openFile(target.relativePath, target.name);
        break;
      case 'mention':
        if (mentionable(target)) onMentionInChat?.(target.relativePath);
        break;
      case 'copy-path':
        void copyPath(target.relativePath);
        break;
      case 'rename':
        beginRename(target);
        break;
      case 'delete':
        if (
          mutable(target.relativePath) &&
          !target.savedCopy &&
          !mutations?.busy
        ) {
          setDeleteError(null);
          setDeleteTarget(target);
        }
        break;
      case 'download':
        onDownloadFile?.(target.relativePath);
        break;
    }
  };
  const confirmDelete = async (): Promise<void> => {
    if (
      deleteTarget === null ||
      mutations === undefined ||
      mutations.busy ||
      submittingRef.current ||
      !mutable(deleteTarget.relativePath) ||
      deleteTarget.savedCopy
    )
      return;
    submittingRef.current = true;
    try {
      await mutations.onDelete(
        deleteTarget.relativePath,
        deleteTarget.kind === 'directory',
      );
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : 'Couldn’t delete this file. Try again.',
      );
    } finally {
      submittingRef.current = false;
    }
  };
  const editorRow =
    editor === null ? null : (
      <div
        data-testid="files-tree-inline-editor-container"
        data-parent-path={editor.parentDir}
        data-create-kind={editor.mode}
        className="px-2 py-1"
      >
        <div className="flex items-center gap-2">
          {editor.isDir ? (
            <FolderIcon />
          ) : (
            <FileTypeIcon filename={editor.value || 'untitled'} />
          )}
          <div className="min-w-0 flex-1">
            <TextInput
              ref={editorInputRef}
              density="compact"
              aria-label={
                editor.mode === 'rename' ? 'New name' : 'File or folder name'
              }
              data-testid="files-tree-inline-editor"
              aria-invalid={editorError !== null || undefined}
              aria-describedby={
                editorError !== null ? editorErrorId : undefined
              }
              data-parent-path={editor.parentDir}
              value={editor.value}
              disabled={mutations?.busy}
              onChange={(event): void => {
                setEditor({ ...editor, value: event.target.value });
                setEditorError(null);
              }}
              onKeyDown={(event): void => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  void submitEditor();
                } else if (event.key === 'Escape' && !mutations?.busy) {
                  event.stopPropagation();
                  setEditor(null);
                }
              }}
              onBlur={(): void => {
                if (
                  !editor.value.trim() &&
                  editor.mode !== 'rename' &&
                  !mutations?.busy
                )
                  setEditor(null);
              }}
            />
          </div>
        </div>
        {editorError !== null && (
          <FieldError id={editorErrorId} announce>
            {editorError}
          </FieldError>
        )}
      </div>
    );
  const toolbar =
    mutations !== undefined ||
    search !== undefined ||
    onReload !== undefined ? (
      <Surface variant="section" boundary="bottom">
        <div className="flex items-center gap-1 px-2 py-1.5">
          <span className="mr-auto text-2xs font-medium fg-secondary">
            Files
          </span>
          {mutations !== undefined && (
            <>
              <Tooltip label="New file">
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  iconOnly
                  aria-label="New file"
                  data-testid="files-tree-new-file"
                  disabled={!mutable(dir) || mutations.busy}
                  onClick={(): void => beginCreate('create-file', dir)}
                >
                  <NewFileIcon size="sm" />
                </Button>
              </Tooltip>
              <Tooltip label="New folder">
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  iconOnly
                  aria-label="New folder"
                  data-testid="files-tree-new-folder"
                  disabled={!mutable(dir) || mutations.busy}
                  onClick={(): void => beginCreate('create-directory', dir)}
                >
                  <NewFolderIcon size="sm" />
                </Button>
              </Tooltip>
            </>
          )}
          {search !== undefined && (
            <Tooltip label="Search files">
              <Button
                type="button"
                variant="ghost"
                size="compact"
                iconOnly
                aria-label="Search files"
                data-testid="files-tree-search-toggle"
                aria-expanded={searchOpen}
                onClick={(): void => {
                  if (searchOpen) closeSearch();
                  else setSearchOpen(true);
                }}
              >
                <SearchFilesIcon size="sm" />
              </Button>
            </Tooltip>
          )}
          {onReload !== undefined && (
            <FilesTreeRefreshButton
              onClick={onReload}
              disabled={reloading || mutations?.busy}
              spinning={reloading || mutations?.busy}
            />
          )}
        </div>
      </Surface>
    ) : null;
  const searchTray = searchOpen ? (
    <Surface variant="section" boundary="bottom">
      <div
        data-testid="files-tree-search"
        className="flex items-center gap-1.5 px-2 py-1.5"
      >
        <SearchField
          ref={searchInputRef}
          className="flex-1"
          data-testid="files-tree-search-input"
          aria-label="Filter files"
          placeholder="Filter files…"
          value={searchQuery}
          onValueChange={setSearchQuery}
          onKeyDown={(event): void => {
            // Escape closes the tray (and clears it), as on desktop.
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeSearch();
            }
          }}
          clearLabel="Clear search"
          clearTestId="files-tree-search-clear"
        />
        <Button
          type="button"
          variant="ghost"
          size="compact"
          iconOnly
          aria-label="Close search"
          data-testid="files-tree-search-close"
          onClick={closeSearch}
        >
          <CloseIcon size="xs" aria-hidden="true" />
        </Button>
      </div>
    </Surface>
  ) : null;
  const searchBody = (
    <>
      {search?.error !== undefined ? (
        <ErrorBanner
          className="mx-2 my-2"
          error={search.error}
          testId="files-tree-search-error"
        />
      ) : search?.loading || results === null ? (
        <div className="px-3 py-2 text-xs fg-secondary">Searching…</div>
      ) : (
        <>
          {results.matchCount === 0 ? (
            <div
              data-testid="files-tree-search-empty"
              className="px-3 py-2 text-xs fg-secondary"
            >
              No files match “{debouncedQuery}”.
            </div>
          ) : (
            flattenFilesTabSearchTree(results.nodes, collapsedResults).map(
              ({ node, depth }): JSX.Element => {
                const target: Omit<FilesTabActionTarget, 'x' | 'y'> = {
                  kind: node.kind,
                  relativePath: node.relativePath,
                  name: node.name,
                  savedCopy: false,
                };
                if (
                  editor?.mode === 'rename' &&
                  editor.targetPath === node.relativePath
                )
                  return <div key={node.relativePath}>{editorRow}</div>;
                return (
                  <FileTreeRow
                    key={node.relativePath}
                    label={node.name}
                    depth={depth}
                    isDirectory={node.kind === 'directory'}
                    expanded={!collapsedResults.has(node.relativePath)}
                    dataPath={node.relativePath}
                    dataNodeId={node.relativePath}
                    tabIndex={0}
                    dataTestId="files-tree-search-result"
                    trailingAction={rowActions(target)}
                    onContextMenu={openMenu(target)}
                    onKeyDown={(event): void => rowKeyDown(event, target)}
                    onClick={(): void => {
                      if (node.kind === 'file')
                        openFile(node.relativePath, node.name);
                      else
                        setCollapsedResults((current): ReadonlySet<string> => {
                          const next = new Set(current);
                          if (next.has(node.relativePath))
                            next.delete(node.relativePath);
                          else next.add(node.relativePath);
                          return next;
                        });
                    }}
                  />
                );
              },
            )
          )}
          {results.shownCount < results.matchCount && (
            <div
              data-testid="files-tree-search-truncated"
              className="px-3 py-2 text-xs fg-secondary"
            >
              Showing {results.shownCount} of {results.matchCount} matches.
              Narrow the search to see the rest.
            </div>
          )}
          {search?.index?.truncated && (
            <div
              data-testid="files-tree-index-truncated"
              className="px-3 py-2 text-xs fg-secondary"
            >
              Search results may be incomplete. Some matching files could not be
              listed.
            </div>
          )}
        </>
      )}
    </>
  );

  const renderRootChip = (root: FilesTabRoot): JSX.Element => (
    <button
      key={root.localId}
      type="button"
      onClick={(): void => onSelectRoot?.(root.localId)}
      className={`focus-ring rounded-md border px-2 py-0.5 text-2xs transition-colors ${
        root.localId === activeRootLocalId
          ? 'border-line-accent/40 bg-fg-primary/[0.06] fg-primary'
          : 'fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary'
      }`}
    >
      {isCoworkWorkspaceFileRoot({ id: root.localId, kind: root.kind }) ? (
        // The Cowork root carries the user's project title.
        <span className={REPLAY_MASK_CLASS}>{root.label}</span>
      ) : (
        root.label
      )}
    </button>
  );

  const rootSwitcher =
    roots && roots.length > 1 && onSelectRoot ? (
      <Surface variant="section" boundary="bottom">
        <div
          className="flex flex-wrap gap-1.5 px-3 py-2"
          data-testid="activity-files-roots"
        >
          {rootGroups.primary.map(renderRootChip)}
          {rootGroups.appManaged.length > 0 && (
            <>
              <FileRootGroupRow
                label={appManagedRootsLabel ?? ''}
                expanded={managedRootsExpanded}
                controlsId={managedRootsGroupId}
                onToggle={toggleManagedRoots}
                nodeId="group-app-managed"
                presentation="switcher"
                dataTestId="activity-files-root-group"
              />
              <div
                id={managedRootsGroupId}
                role="group"
                aria-label={appManagedRootsLabel}
                className="contents"
              >
                {managedRootsExpanded &&
                  rootGroups.appManaged.map(renderRootChip)}
              </div>
            </>
          )}
        </div>
      </Surface>
    ) : null;

  const breadcrumb =
    dir.length > 0 && onOpenDirectory ? (
      <Surface variant="section" boundary="bottom">
        <div
          className="flex items-center gap-1 px-3 py-1.5 text-2xs"
          data-testid="activity-files-breadcrumb"
        >
          <Button
            type="button"
            variant="secondary"
            size="compact"
            onClick={(): void => onOpenDirectory(parentDir)}
            aria-label="Up one directory"
          >
            ../
          </Button>
          <span className="truncate fg-primary/80">{dir}</span>
        </div>
      </Surface>
    ) : null;

  const downloadErrorNode =
    downloadError === undefined ? null : (
      <ErrorBanner
        className="mx-2 my-1"
        error={downloadError}
        testId="activity-files-download-error"
      />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onRootKeyDown}>
      {toolbar}
      {searchTray}
      {rootSwitcher}
      {breadcrumb}
      {downloadErrorNode}
      {downloadNotice !== undefined && (
        <Surface variant="section" boundary="bottom">
          <div
            className="px-3 py-1 text-2xs fg-secondary"
            data-testid="activity-files-download-notice"
          >
            {downloadNotice}
          </div>
        </Surface>
      )}
      {statusBar}
      {truncated && (
        <Surface variant="section" boundary="bottom">
          <div className="px-3 py-1 text-2xs fg-secondary">
            Showing first 2000 entries
          </div>
        </Surface>
      )}
      <div
        className="min-h-0 flex-1 overflow-auto py-1"
        onContextMenu={
          mutable(dir) && !mutations?.busy
            ? (event): void => {
                if (
                  event.target instanceof HTMLElement &&
                  event.target.closest(
                    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
                  )
                )
                  return;
                openMenu({
                  kind: 'background',
                  relativePath: dir,
                  name: dir || 'root',
                  savedCopy: false,
                })(event);
              }
            : undefined
        }
        data-testid={
          emptyState !== undefined && !searchActive
            ? undefined
            : (dataTestId ?? 'activity-files')
        }
      >
        {editor !== null && editor.mode !== 'rename' && editorRow}
        {searchActive ? (
          searchBody
        ) : (entries.length === 0 || emptyState !== undefined) && loading ? (
          <DelayedLoadingPlaceholder slowNote="Still loading files…">
            <Skeleton
              loading
              label="Loading files"
              testId="activity-files-loading"
            >
              {SAMPLE_TREE_ENTRIES.map((entry) => (
                <FileTreeRow
                  key={entry.name}
                  label={entry.name}
                  depth={0}
                  isDirectory={entry.isDir}
                  touchTarget={touchTarget}
                />
              ))}
            </Skeleton>
          </DelayedLoadingPlaceholder>
        ) : entries.length === 0 || emptyState !== undefined ? (
          <div
            className="px-4 py-6 text-center text-xs fg-secondary"
            data-testid="activity-files-empty"
          >
            {emptyState ??
              (statusBar === undefined ? 'No files loaded.' : null)}
          </div>
        ) : (
          entries.map((entry) => {
            const relativePath = entry.relativePath ?? joinDir(entry.name);
            if (editor?.mode === 'rename' && editor.targetPath === relativePath)
              return <div key={relativePath}>{editorRow}</div>;
            const target: Omit<FilesTabActionTarget, 'x' | 'y'> = {
              kind: entry.isDir ? 'directory' : 'file',
              relativePath,
              name: entry.name,
              savedCopy: entry.savedCopy === true,
            };
            return (
              <FileTreeRow
                dataNodeId={relativePath}
                tabIndex={0}
                onContextMenu={openMenu(target)}
                onKeyDown={(event): void => rowKeyDown(event, target)}
                key={relativePath}
                label={entry.name}
                depth={0}
                isDirectory={entry.isDir}
                dataPath={relativePath}
                secondaryLabel={entry.secondaryLabel}
                badge={
                  entry.savedCopy === true
                    ? 'Saved copy'
                    : entry.currentSession === true
                      ? 'This chat'
                      : undefined
                }
                title={
                  entry.savedCopy === true
                    ? 'Saved copy from a completed turn; may differ from current working files'
                    : undefined
                }
                dataTestId={
                  entry.isDir
                    ? (folderRowDataTestId ?? rowDataTestId)
                    : rowDataTestId
                }
                touchTarget={touchTarget}
                trailingAction={rowActions(target)}
                onClick={(): void => {
                  if (entry.isDir) {
                    onOpenDirectory?.(relativePath);
                  } else {
                    if (
                      onSelectFile &&
                      workspaceLocalId &&
                      worktreeLocalId &&
                      fileRootLocalId
                    ) {
                      onSelectFile({
                        kind: 'file',
                        title: entry.name,
                        request: {
                          projectId: workspaceLocalId,
                          worktreeId: worktreeLocalId,
                          fileRootLocalId,
                          relativePath,
                        },
                      });
                    } else {
                      onOpenFile?.(relativePath);
                    }
                  }
                }}
              />
            );
          })
        )}
      </div>
      {actionError !== null && (
        <Notice
          intent="destructive"
          className="mx-2 my-2"
          data-testid="files-tree-action-error"
          dismissLabel="Dismiss copy error"
          onDismiss={(): void => setActionError(null)}
        >
          {actionError}
        </Notice>
      )}
      {mutations?.error && editor === null && (
        <Notice
          intent="destructive"
          className="mx-2 my-2"
          data-testid="files-tree-mutation-error"
          dismissLabel="Dismiss file error"
          onDismiss={mutations.onClearError}
        >
          {mutations.error}
        </Notice>
      )}
      {menu !== null && (
        <FilesTabActionMenu
          target={menu}
          canMutate={
            !mutations?.busy && mutable(menu.relativePath) && !menu.savedCopy
          }
          canMention={mentionable(menu)}
          canDownload={
            onDownloadFile !== undefined &&
            (canDownloadFile?.(menu.relativePath) ?? true)
          }
          onAction={onMenuAction}
          onClose={(): void => setMenu(null)}
        />
      )}
      {deleteTarget !== null && mutations !== undefined && (
        <ConfirmDialog
          title={`Delete ${deleteTarget.name}?`}
          message={
            deleteTarget.kind === 'directory'
              ? 'This folder and everything in it will be deleted.'
              : 'This file will be deleted.'
          }
          confirmLabel="Delete"
          busyLabel="Deleting…"
          destructive
          busy={mutations.busy}
          errorMessage={deleteError}
          dataTestId="files-tree-delete-dialog"
          confirmTestId="files-tree-delete-confirm"
          onCancel={(): void => setDeleteTarget(null)}
          onConfirm={(): void => {
            void confirmDelete();
          }}
        />
      )}
    </div>
  );
}
