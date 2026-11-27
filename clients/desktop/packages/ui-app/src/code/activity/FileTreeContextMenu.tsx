'use client';

import { useRef, type JSX, type MouseEvent, type ReactNode } from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  MenuItem,
  MenuItemIcon,
  Menu,
  MenuPointAnchor,
  Tooltip,
  actionMenuRowIcon,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import {
  ClipboardIcon,
  CopyIcon,
  CutIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  MentionIcon,
  PageTextAddIcon,
  PencilIcon,
  StarIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/** Every row the file tree's right-click menu can show, in menu order. */
export type FileTreeMenuKey =
  | 'new-file'
  | 'new-folder'
  | 'open'
  | 'open-side'
  | 'open-external'
  | 'open-in-app'
  | 'mention'
  | 'start-page'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'copy-path'
  | 'copy-absolute-path'
  | 'rename'
  | 'open-in-file-manager'
  | 'download'
  | 'delete';

/** What was right-clicked: a file, a folder, or the empty tree background. */
export type FileTreeMenuTargetKind = 'file' | 'folder' | 'background';

export interface FileTreeMenuLabels {
  readonly newFile: string;
  readonly newFolder: string;
  readonly open: string;
  readonly openToSide: string;
  readonly openExternal: string;
  /** Leads the open-in-app row; the app's icon follows it. */
  readonly openIn: string;
  readonly mention: string;
  readonly setStartPage: string;
  readonly removeStartPage: string;
  readonly cut: string;
  readonly copy: string;
  readonly paste: string;
  readonly copyPath: string;
  readonly copyAbsolutePath: string;
  readonly rename: string;
  readonly download: string;
  readonly delete: string;
}

export const DEFAULT_FILE_TREE_MENU_LABELS: FileTreeMenuLabels = {
  newFile: 'New file…',
  newFolder: 'New folder…',
  open: 'Open',
  openToSide: 'Open to the side',
  openExternal: 'Open with default application',
  openIn: 'Open in',
  mention: 'Mention in chat',
  setStartPage: 'Set as start page',
  removeStartPage: 'Remove start page',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  copyPath: 'Copy relative path',
  copyAbsolutePath: 'Copy path',
  rename: 'Rename',
  download: 'Download',
  delete: 'Delete',
};

/**
 * The file tree's right-click menu, described by what the host supports:
 * each row appears only when its callback is supplied (and the target kind
 * allows it), so desktop and web share one menu without branching on host.
 */
export interface FileTreeMenuOptions {
  readonly targetKind: FileTreeMenuTargetKind;
  readonly onNewFile?: () => void;
  readonly onNewFolder?: () => void;
  readonly onOpen?: () => void;
  readonly onOpenToSide?: () => void;
  readonly onOpenExternal?: () => void;
  /** Open the file in the user's preferred app, shown by its icon. */
  readonly openInApp?: {
    readonly appName: string;
    readonly iconSrc: string;
    readonly onSelect: () => void;
  };
  readonly onMention?: () => void;
  readonly startPage?: {
    readonly isStartPage: boolean;
    readonly onToggle: () => void;
  };
  readonly onCut?: () => void;
  readonly onCopy?: () => void;
  readonly onPaste?: () => void;
  /** Paste stays listed but disabled while nothing has been cut or copied. */
  readonly canPaste?: boolean;
  readonly onCopyPath?: () => void;
  readonly copyPathTooltip?: string;
  readonly onCopyAbsolutePath?: () => void;
  readonly onRename?: () => void;
  /** Reveal in the platform file manager; the label names that app. */
  readonly openInFileManager?: {
    readonly label: string;
    readonly onSelect: () => void;
  };
  readonly onDownload?: () => void;
  readonly onDelete?: () => void;
  readonly labels?: Partial<FileTreeMenuLabels>;
  /** Overrides the default `files-tree-action-<key>` test ids. */
  readonly testIds?: Partial<Record<FileTreeMenuKey, string>>;
}

type FileTreeMenuGroup =
  | 'create'
  | 'open'
  | 'chat'
  | 'clipboard'
  | 'paths'
  | 'rename'
  | 'reveal'
  | 'delete';

interface FileTreeMenuRow {
  readonly group: FileTreeMenuGroup;
  readonly key: FileTreeMenuKey;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly tooltip?: string;
}

/**
 * Builds the file tree menu rows: create, open, chat, clipboard, paths,
 * rename and reveal groups, with Delete alone in the last group. Neighbouring
 * groups that hold a single row each share one section. Variants of
 * one action (Open, Open to the Side, …) share one icon element so only the
 * first row of the run shows it.
 */
export function deriveFileTreeMenuItems(
  options: FileTreeMenuOptions,
): ActionMenuItem<FileTreeMenuKey>[] {
  const labels = { ...DEFAULT_FILE_TREE_MENU_LABELS, ...options.labels };
  const isFile = options.targetKind === 'file';
  const isEntry = options.targetKind !== 'background';
  const openIcon = <FileIcon />;
  const copyIcon = <CopyIcon />;
  const rows: FileTreeMenuRow[] = [];
  const add = (
    when: boolean,
    row: Omit<FileTreeMenuRow, 'onSelect'>,
    onSelect: (() => void) | undefined,
  ): void => {
    if (when && onSelect) rows.push({ ...row, onSelect });
  };

  add(
    true,
    {
      group: 'create',
      key: 'new-file',
      label: labels.newFile,
      icon: <PageTextAddIcon />,
    },
    options.onNewFile,
  );
  add(
    true,
    {
      group: 'create',
      key: 'new-folder',
      label: labels.newFolder,
      icon: <FolderPlusIcon />,
    },
    options.onNewFolder,
  );
  add(
    isFile,
    { group: 'open', key: 'open', label: labels.open, icon: openIcon },
    options.onOpen,
  );
  add(
    isFile,
    {
      group: 'open',
      key: 'open-side',
      label: labels.openToSide,
      icon: openIcon,
    },
    options.onOpenToSide,
  );
  add(
    isFile,
    {
      group: 'open',
      key: 'open-external',
      label: labels.openExternal,
      icon: openIcon,
    },
    options.onOpenExternal,
  );
  add(
    isFile,
    {
      group: 'open',
      key: 'open-in-app',
      label: `${labels.openIn} ${options.openInApp?.appName ?? ''}`,
      icon: openIcon,
    },
    options.openInApp?.onSelect,
  );
  add(
    isFile,
    {
      group: 'chat',
      key: 'mention',
      label: labels.mention,
      icon: <MentionIcon />,
    },
    options.onMention,
  );
  add(
    isFile,
    {
      group: 'chat',
      key: 'start-page',
      label: options.startPage?.isStartPage
        ? labels.removeStartPage
        : labels.setStartPage,
      icon: <StarIcon />,
    },
    options.startPage?.onToggle,
  );
  add(
    isEntry,
    { group: 'clipboard', key: 'cut', label: labels.cut, icon: <CutIcon /> },
    options.onCut,
  );
  add(
    isEntry,
    { group: 'clipboard', key: 'copy', label: labels.copy, icon: copyIcon },
    options.onCopy,
  );
  add(
    true,
    {
      group: 'clipboard',
      key: 'paste',
      label: labels.paste,
      icon: <ClipboardIcon />,
      disabled: options.canPaste === false,
    },
    options.onPaste,
  );
  add(
    isEntry,
    {
      group: 'paths',
      key: 'copy-path',
      label: labels.copyPath,
      icon: copyIcon,
      tooltip: options.copyPathTooltip,
    },
    options.onCopyPath,
  );
  add(
    isEntry,
    {
      group: 'paths',
      key: 'copy-absolute-path',
      label: labels.copyAbsolutePath,
      icon: copyIcon,
    },
    options.onCopyAbsolutePath,
  );
  add(
    isEntry,
    {
      group: 'rename',
      key: 'rename',
      label: labels.rename,
      icon: <PencilIcon />,
    },
    options.onRename,
  );
  add(
    isEntry,
    {
      group: 'reveal',
      key: 'open-in-file-manager',
      label: options.openInFileManager?.label ?? '',
      icon: <FolderIcon />,
      tooltip: options.openInFileManager?.label,
    },
    options.openInFileManager?.onSelect,
  );
  add(
    isFile,
    {
      group: 'reveal',
      key: 'download',
      label: labels.download,
      icon: <DownloadIcon />,
    },
    options.onDownload,
  );
  add(
    isEntry,
    {
      group: 'delete',
      key: 'delete',
      label: labels.delete,
      icon: <TrashIcon />,
    },
    options.onDelete,
  );

  // A group of two or more rows is its own section. Consecutive groups a host
  // fills with a single row share one section, so a host offering few
  // actions does not get a divider between every row. Delete is always last
  // and alone.
  const groupSize = (group: FileTreeMenuGroup | undefined): number =>
    rows.filter((candidate) => candidate.group === group).length;
  return rows.map(({ group, ...row }, index) => {
    const previousGroup = rows[index - 1]?.group;
    const pooledWithPrevious =
      group !== 'delete' &&
      groupSize(group) === 1 &&
      groupSize(previousGroup) === 1;
    return {
      ...row,
      testId: options.testIds?.[row.key] ?? `files-tree-action-${row.key}`,
      separatorBefore:
        index > 0 && previousGroup !== group && !pooledWithPrevious,
    };
  });
}

export interface FileTreeContextMenuProps extends FileTreeMenuOptions {
  /** Pointer position the menu opens at, in viewport coordinates. */
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
}

const keepFocusInTree = (event: MouseEvent<HTMLDivElement>): void => {
  event.preventDefault();
  event.stopPropagation();
};

/** The file tree's right-click menu, shared by desktop and web. */
export function FileTreeContextMenu({
  x,
  y,
  onClose,
  ...options
}: FileTreeContextMenuProps): JSX.Element | null {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const items = deriveFileTreeMenuItems(options);
  const select = (item: ActionMenuItem<FileTreeMenuKey>): void => {
    if (item.disabled || !item.onSelect) return;
    item.onSelect();
    onClose();
  };
  // The open-in-app row shows the app's icon after its label, so it renders
  // outside the generic rows while keeping their icon and group rules.
  const appIndex = items.findIndex((item) => item.key === 'open-in-app');
  const appItem = items[appIndex];
  const openInApp = options.openInApp;
  const openInLabel =
    options.labels?.openIn ?? DEFAULT_FILE_TREE_MENU_LABELS.openIn;

  if (!document.body) return null;

  return (
    <>
      <MenuPointAnchor ref={anchorRef} x={x} y={y} ownerDocument={document} />
      <Menu
        open
        onOpenChange={(open): void => {
          if (!open) onClose();
        }}
        anchorRef={anchorRef}
        placement="bottom-left"
        gap={0}
        motion="none"
        data-testid="files-tree-action-menu"
        aria-label="File actions"
        className="z-dropdown flex w-max min-w-52 max-w-[calc(100vw-1rem)] flex-col"
        onContextMenu={(event): void => event.preventDefault()}
      >
        <ActionMenuRowStyle>
          <div className="contents" onMouseDown={keepFocusInTree}>
            {appItem && openInApp ? (
              <>
                <ActionMenuItems
                  items={items.slice(0, appIndex)}
                  onSelect={select}
                />
                <Tooltip label={appItem.label} className="w-full">
                  <MenuItem
                    data-testid={appItem.testId}
                    aria-label={appItem.label}
                    onClick={(event): void => {
                      event.preventDefault();
                      select(appItem);
                    }}
                  >
                    <MenuItemIcon>
                      {actionMenuRowIcon(items, appIndex)}
                    </MenuItemIcon>
                    <span>{openInLabel}</span>
                    <img
                      src={openInApp.iconSrc}
                      alt=""
                      className="h-4 w-4"
                      draggable={false}
                    />
                  </MenuItem>
                </Tooltip>
                <ActionMenuItems
                  items={items.slice(appIndex + 1)}
                  onSelect={select}
                />
              </>
            ) : (
              <ActionMenuItems items={items} onSelect={select} />
            )}
          </div>
        </ActionMenuRowStyle>
      </Menu>
    </>
  );
}
